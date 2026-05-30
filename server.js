import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as cheerio from "cheerio";

const app = express();
const port = Number(process.env.PORT || 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deliveryUnavailable = "배송 정보: 확인할 수 없음";

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, openAiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post("/api/analyze", async (request, response) => {
  const memo = String(request.body?.memo || "").trim();
  if (!memo) return response.status(400).json({ error: "분석할 메모를 입력해 주세요." });

  try {
    if (!process.env.OPENAI_API_KEY) {
      return response.json({ events: createDemoAnalysis(), demoMode: true });
    }
    const events = await analyzeMemoWithOpenAI(memo);
    return response.json({ events, demoMode: false });
  } catch (error) {
    console.error("Memo analysis failed:", error.message);
    return response.status(502).json({ error: "AI 메모 분석에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

app.post("/api/recommend", async (request, response) => {
  const item = sanitizeItem(request.body?.item);
  if (!item.name) return response.status(400).json({ error: "추천할 물품 이름이 필요합니다." });

  try {
    const crawledProducts = await crawlNaverShopping(item.name).catch((error) => {
      console.warn("Shopping crawl unavailable, using search fallback:", error.message);
      return [];
    });
    const sourceProducts = crawledProducts.length ? crawledProducts : [createSearchFallback(item.name)];

    if (!process.env.OPENAI_API_KEY) {
      return response.json({
        recommendations: rankProductsForDemo(sourceProducts, item),
        demoMode: true,
      });
    }

    const recommendations = await recommendProductsWithOpenAI(item, sourceProducts);
    return response.json({ recommendations, demoMode: false });
  } catch (error) {
    console.error("Product recommendation failed:", error.message);
    return response.status(502).json({ error: "상품 정보를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));
app.get("*", (_request, response) => response.sendFile(path.join(distPath, "index.html")));

app.listen(port, () => {
  console.log(`살뜰 server listening on http://localhost:${port}`);
});

async function analyzeMemoWithOpenAI(memo) {
  const today = new Date().toISOString().slice(0, 10);
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            eventName: { type: "string" },
            eventDateText: { type: "string" },
            eventDate: { type: ["string", "null"] },
            eventDateConfidence: { type: "string", enum: ["high", "medium", "low"] },
            mentionedItems: { type: "array", items: itemSchema() },
            suggestedItems: { type: "array", items: itemSchema() },
          },
          required: ["eventName", "eventDateText", "eventDate", "eventDateConfidence", "mentionedItems", "suggestedItems"],
        },
      },
    },
    required: ["events"],
  };

  const result = await callOpenAI({
    instructions: [
      "You are a Korean household shopping execution assistant.",
      `Today's actual date is ${today}. Interpret relative dates using this date.`,
      "Extract family events and purchase candidates from the user's messy Korean memo.",
      "Separate products explicitly mentioned by the user into mentionedItems and context-based extra recommendations into suggestedItems.",
      "Never decide whether the user already owns an item. If a date is ambiguous, set the ISO date to null and confidence to low.",
      "Write concise, warm Korean UI copy. Suggested items must have a concrete reason.",
    ].join("\n"),
    input: memo,
    schemaName: "shopping_memo_analysis",
    schema,
  });
  return result.events;
}

async function recommendProductsWithOpenAI(item, crawledProducts) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      recommendations: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            productTitle: { type: "string" },
            price: { type: "string" },
            link: { type: "string" },
            deliveryInfo: { type: "string" },
            reason: { type: "string" },
            caution: { type: "string" },
          },
          required: ["productTitle", "price", "link", "deliveryInfo", "reason", "caution"],
        },
      },
    },
    required: ["recommendations"],
  };

  return (await callOpenAI({
    instructions: [
      "You recommend up to 3 Korean shopping candidates for a household purchase task.",
      "Use only products from the crawledProducts JSON. Copy each chosen product title, link, price, and deliveryInfo exactly.",
      "Do not invent delivery dates or availability. If unavailable, keep the provided fallback delivery text.",
      "Do not rank only by popularity. Consider event, needed date, purchase deadline, priority, notes, and whether delivery data exists.",
      "Write the reason and caution in concise Korean.",
    ].join("\n"),
    input: JSON.stringify({ item, crawledProducts }, null, 2),
    schemaName: "product_recommendations",
    schema,
  })).recommendations;
}

function itemSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      neededDateText: { type: "string" },
      neededDate: { type: ["string", "null"] },
      purchaseDeadlineText: { type: "string" },
      purchaseDeadline: { type: ["string", "null"] },
      priority: { type: "string", enum: ["높음", "중간", "낮음"] },
      reason: { type: "string" },
      note: { type: "string" },
    },
    required: ["name", "neededDateText", "neededDate", "purchaseDeadlineText", "purchaseDeadline", "priority", "reason", "note"],
  };
}

async function callOpenAI({ instructions, input, schemaName, schema }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions,
      input,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = data.output_text || data.output
    ?.flatMap((entry) => entry.content || [])
    .find((entry) => entry.type === "output_text")
    ?.text;
  if (!text) throw new Error("OpenAI response did not contain structured output.");
  return JSON.parse(text);
}

async function crawlNaverShopping(query) {
  const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`Shopping crawl returned ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const products = [];
  const seen = new Set();

  $("a[href]").each((_index, element) => {
    if (products.length >= 12) return;
    const anchor = $(element);
    const href = anchor.attr("href");
    const title = cleanText(anchor.attr("title") || anchor.find("img").attr("alt") || anchor.text());
    const container = anchor.closest("div, li");
    const text = cleanText(container.text());
    const image = anchor.find("img").attr("src") || anchor.find("img").attr("data-src") || "";

    if (!href || !title || title.length < 3 || seen.has(href)) return;
    if (!/shopping\.naver|smartstore\.naver|brand\.naver|naver\.me|cr2\.shopping\.naver/i.test(href)) return;

    seen.add(href);
    products.push({
      productTitle: title.slice(0, 180),
      price: text.match(/\d{1,3}(?:,\d{3})+\s*원/)?.[0] || "가격 확인 필요",
      link: href,
      deliveryInfo: extractDelivery(text),
      image,
    });
  });

  return products;
}

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function extractDelivery(text) {
  const match = text.match(/(?:무료배송|오늘출발|내일도착|도착보장|배송비\s*[\d,]+원|배송\s*예정)/);
  return match ? `배송 정보: ${match[0]}` : deliveryUnavailable;
}

function createSearchFallback(query) {
  return {
    productTitle: `${query} 검색 결과 직접 확인`,
    price: "가격 확인 필요",
    link: `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`,
    deliveryInfo: deliveryUnavailable,
    image: "",
  };
}

function rankProductsForDemo(products, item) {
  const deadline = item.purchaseDeadline ? `구매 마감일 ${item.purchaseDeadline}` : "구매 마감일 확인 전";
  return products.slice(0, 3).map((product) => ({
    ...product,
    reason: `${item.eventName || "관련 일정"}에 필요한 ${item.name} 후보예요. ${deadline}을 고려해 배송 조건을 상품 페이지에서 확인해 주세요.`,
    caution: product.deliveryInfo === deliveryUnavailable
      ? "배송 정보를 수집하지 못했어요. 결제 전에 도착 가능일을 꼭 확인해 주세요."
      : "상품 페이지에서 옵션과 실제 도착 예정일을 다시 확인해 주세요.",
  }));
}

function sanitizeItem(value = {}) {
  return {
    name: String(value.name || "").slice(0, 120),
    eventName: String(value.eventName || "").slice(0, 160),
    neededDate: value.neededDate || null,
    purchaseDeadline: value.purchaseDeadline || null,
    priority: String(value.priority || "중간").slice(0, 20),
    note: String(value.note || "").slice(0, 500),
  };
}

function createDemoAnalysis() {
  const year = new Date().getFullYear();
  return [
    {
      eventName: "지우 유치원 소풍",
      eventDateText: "다음 주 금요일",
      eventDate: null,
      eventDateConfidence: "low",
      mentionedItems: [
        demoItem("도시락통", "소풍 당일", null, "소풍 3일 전", null, "높음", "새로 사야 한다고 직접 언급한 준비물이에요.", "가볍고 아이가 열기 쉬운지 확인"),
        demoItem("물통", "소풍 당일", null, "소풍 3일 전", null, "높음", "상태를 확인해야 한다고 직접 언급한 준비물이에요.", "집에 있는 물통 상태 먼저 확인"),
        demoItem("돗자리", "소풍 당일", null, "소풍 3일 전", null, "중간", "집에 있는지 확인해야 한다고 직접 언급했어요.", "보유 여부 확인 후 구매"),
      ],
      suggestedItems: [
        demoItem("간식 봉투", "소풍 당일", null, "소풍 3일 전", null, "중간", "소풍 간식을 나눠 담을 때 유용할 수 있어요.", "유치원 안내문 먼저 확인"),
        demoItem("이름 스티커", "소풍 당일", null, "소풍 3일 전", null, "낮음", "준비물이 섞이지 않도록 표시할 때 쓸 수 있어요.", "집에 남은 수량 확인"),
      ],
    },
    {
      eventName: "엄마 생신",
      eventDateText: "다음 달 초",
      eventDate: null,
      eventDateConfidence: "low",
      mentionedItems: [
        demoItem("엄마 생신 선물", "다음 달 초", null, "이번 주 안", null, "중간", "미리 알아봐야 한다고 직접 언급한 선물이에요.", "취향과 예산 정하기"),
      ],
      suggestedItems: [],
    },
    {
      eventName: "미뤄 둔 생활 쇼핑",
      eventDateText: "날짜 미정",
      eventDate: null,
      eventDateConfidence: "low",
      mentionedItems: [
        demoItem("남편 와이셔츠", "날짜 미정", null, "이번 주 안", null, "낮음", "계속 미뤘다고 직접 언급한 생활 쇼핑이에요.", "사이즈와 선호 색상 확인"),
      ],
      suggestedItems: [],
    },
  ];
}

function demoItem(name, neededDateText, neededDate, purchaseDeadlineText, purchaseDeadline, priority, reason, note) {
  return { name, neededDateText, neededDate, purchaseDeadlineText, purchaseDeadline, priority, reason, note };
}
