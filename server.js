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
      console.warn("Product search crawl unavailable, using search fallback:", error.message);
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

app.post("/api/products/recommend", async (request, response) => {
  const item = sanitizeProductItem(request.body?.item);
  const userConstraints = sanitizeUserConstraints(request.body?.userConstraints);
  if (!item.itemName) {
    return response.status(400).json({ error: "추천할 물품 이름이 필요합니다." });
  }

  const naverConfigured = Boolean(
    process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET,
  );
  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);

  try {
    const searchPlan = await buildSearchPlan(item, userConstraints);

    if (searchPlan.needsMoreInfo && !hasUserConstraints(userConstraints)) {
      return response.json({
        needsMoreInfo: true,
        followUpQuestions: searchPlan.followUpQuestions,
        searchPlan,
        candidates: [],
        recommendations: [],
        summary: "",
        limitations: [],
        naverConfigured,
        openAiConfigured,
      });
    }

    let candidates = [];
    let naverMock = false;
    if (naverConfigured) {
      candidates = await searchProductsWithPlan(searchPlan, item);
    } else {
      candidates = createMockCandidates(item, searchPlan);
      naverMock = true;
    }

    if (!candidates.length) {
      return response.status(502).json({
        error: "상품 후보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
      });
    }

    const { filtered, relaxedFilter } = filterCandidates(candidates, searchPlan, item);

    let summary = "";
    let recommendations = [];
    let limitations = [
      "배송일은 판매처별로 달라 정확히 보장할 수 없습니다.",
      "추천은 네이버 쇼핑 API와 제한적 크롤링 데이터 기반입니다.",
    ];
    let recommendationFailed = false;
    try {
      const result = await buildRecommendations(item, searchPlan, filtered);
      summary = result.summary;
      recommendations = result.recommendations;
      if (result.limitations?.length) limitations = result.limitations;
    } catch (error) {
      console.warn("Product recommendation generation failed:", error.message);
      recommendationFailed = true;
    }

    // 최종 추천(또는 폴백 상위 3개) 상품에 대해서만 가벼운 정적 크롤링을 시도한다.
    const linksToCrawl = recommendations.length
      ? recommendations.map((rec) => rec.link)
      : filtered.slice(0, 3).map((candidate) => candidate.link);
    const deliveryByLink = await crawlLinksForDelivery(linksToCrawl);

    recommendations = recommendations.map((rec) => {
      const crawled = deliveryByLink.get(rec.link);
      if (!crawled) return rec;
      return {
        ...rec,
        deliveryInfo: rec.deliveryInfo || crawled.deliveryText || null,
        crawlStatus: crawled.status,
      };
    });

    const publicCandidates = filtered.map((candidate) => {
      const base = toPublicCandidate(candidate);
      const crawled = deliveryByLink.get(candidate.link);
      if (!crawled) return base;
      return {
        ...base,
        deliveryText: base.deliveryText || crawled.deliveryText || null,
        crawlStatus: crawled.status,
      };
    });

    return response.json({
      needsMoreInfo: false,
      followUpQuestions: [],
      searchPlan,
      candidates: publicCandidates,
      recommendations,
      summary,
      limitations,
      relaxedFilter,
      naverConfigured,
      openAiConfigured,
      naverMock,
      recommendationMock: !openAiConfigured,
      recommendationFailed,
    });
  } catch (error) {
    console.error("Product recommendation failed:", error.message);
    return response.status(502).json({
      error: "상품 후보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
    });
  }
});

const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));
app.get("*", (_request, response) => response.sendFile(path.join(distPath, "index.html")));

app.listen(port, () => {
  console.log(`살뜰 server listening on http://localhost:${port}`);
});

async function analyzeMemoWithOpenAI(memo) {
  const todayDate = getTodayDate();
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
      "당신은 가족 일정에서 생기는 구매 과제를 정리하는 한국어 AI 쇼핑 실행 도우미입니다.",
      `오늘 날짜는 ${todayDate}입니다.`,
      "메모의 상대 날짜는 오늘 날짜를 기준으로 가능한 경우 실제 ISO 날짜(YYYY-MM-DD)로 변환하세요.",
      "예: '다음 주 금요일', '이번 주 토요일'처럼 계산 가능한 날짜는 실제 날짜로 변환하세요.",
      "예: '다음 달 초', '언젠가', '소풍 전'처럼 정확한 날짜를 확정할 수 없는 표현은 억지로 날짜를 만들지 말고 null과 low confidence를 사용하세요.",
      "일정의 필요 날짜는 eventDate와 eventDateText에서 한 번만 판단하세요. 같은 일정의 물품마다 필요 날짜를 반복해서 추론하지 마세요.",
      "각 물품의 neededDate, neededDateText, dateConfidence에는 해당 일정에서 판단한 동일한 필요 날짜 정보를 복사하세요. 물품마다 다른 필요 날짜를 새로 만들지 마세요.",
      "각 물품에 대해 실제 필요 날짜와 사용자의 의도를 먼저 판단하고, 늦어도 언제까지 어떤 행동을 해야 하는지 AI 권장 액션 시점으로 추론하세요.",
      "AI 권장 액션 시점은 정확한 배송일 예측이 아니라 참고용 행동 제안입니다. 실제 재고나 배송일을 추측하지 마세요.",
      "recommendedActionTimingText는 '6월 1일~3일 중 구매 후보 보기', '6월 5일까지 기존 물통 상태 확인'처럼 구체적인 날짜와 행동을 함께 포함하세요.",
      "recommendedActionDate는 정렬에 사용할 액션 시작 날짜입니다. recommendedActionEndDate는 기간형 액션의 종료 날짜이며 기간이 아니면 null입니다.",
      "recommendedActionType은 buy, check, compare, prepare_later, date_needed 중 하나입니다.",
      "recommendedActionTimingText에 '이번 주 안', '미리', '전날이나 당일 아침에 챙기기'처럼 모호하거나 구매 과제와 무관한 표현을 쓰지 마세요.",
      "시기를 놓쳐도 근처 매장이나 편의점에서 살 수 있는 소모품이라면 액션 날짜를 일정 가까이 잡고, actionReason에 '시기를 놓쳐도 편의점이나 근처 매장에서 비교적 쉽게 살 수 있다'는 구매 관점의 이유를 설명하세요.",
      "actionReason은 왜 그 날짜에 구매, 비교, 확인 또는 준비 행동을 해야 하는지를 설명하세요.",
      "일정 날짜가 불명확해서 액션 날짜도 정할 수 없다면 recommendedActionDate와 recommendedActionEndDate를 null로 두고 recommendedActionType=date_needed를 사용하세요.",
      "사용자가 직접 언급한 물품은 mentionedItems에 sourceType=user_mentioned로, 맥락상 추가로 챙기면 좋은 물품은 suggestedItems에 sourceType=ai_suggested로 넣으세요.",
      "사용자가 사야 한다고 말했거나, 집에 있는지 또는 상태를 확인해야 한다고 말했거나, 후보를 알아봐야 한다고 말한 물품은 mentionedItems에서 누락하지 마세요.",
      "메모에서 서로 다른 일정이나 날짜 맥락이 나오면 반드시 별도 event 객체로 분리하세요. 다른 일정의 물품을 앞 일정에 섞지 마세요.",
      "각 일정마다 사용자가 직접 말하지 않았지만 실제 구매 후보로 검토할 만한 실용적인 물품 1~3개를 적극적으로 생각하세요.",
      "유용한 추가 후보가 있으면 suggestedItems에 반드시 넣으세요. 단, 억지 추천이나 이미 언급한 물품의 반복은 금지합니다.",
      "정말로 추가 구매 후보가 없는 일정만 suggestedItems를 빈 배열로 둘 수 있습니다.",
      "사용자가 구매가 아니라 확인을 요청한 경우 userIntent=check_existing으로 표시하고, 바로 구매하라고 단정하지 마세요.",
      "초기 분석에서는 상품 검색이나 크롤링을 하지 않습니다. 메모에 있는 정보와 일반적인 준비 리스크만 사용하세요.",
      "가장 중요한 출력은 recommendedActionTimingText와 actionReason입니다. 무엇을 언제 해야 하는지 판단하는 데 도움이 되는 짧은 한국어로 작성하세요.",
      "",
      "추론 예시 1",
      "입력: 다음 주 금요일 아이 소풍. 도시락통 새로 사야 함.",
      "출력 방향: itemName=도시락통, userIntent=buy_new, recommendedActionDate=소풍 5일 전의 ISO 날짜, recommendedActionEndDate=소풍 3일 전의 ISO 날짜, recommendedActionType=buy, recommendedActionTimingText=6월 7일~9일 중 구매 후보 보기, actionReason=배송 후 세척하고 아이가 혼자 열고 닫기 쉬운지 확인할 시간이 필요할 수 있음, timingConfidence=medium.",
      "",
      "추론 예시 2",
      "입력: 물통도 확인해야 함.",
      "출력 방향: itemName=물통, userIntent=check_existing, recommendedActionDate=소풍 5일 전의 ISO 날짜, recommendedActionEndDate=null, recommendedActionType=check, recommendedActionTimingText=6월 7일까지 기존 물통 상태 확인, actionReason=사용자가 구매가 아니라 확인이 필요하다고 표현했으므로 새 구매 전 상태 확인이 우선, timingConfidence=high.",
      "",
      "추론 예시 3",
      "입력: 다음 달 초 엄마 생신 선물도 봐야 함.",
      "출력 방향: itemName=생신 선물, userIntent=consider, recommendedActionDate=null, recommendedActionEndDate=null, recommendedActionType=date_needed, recommendedActionTimingText=생신 날짜 입력 후 최소 7일 전부터 선물 후보 비교, actionReason=선물은 비교·배송·포장 시간이 필요할 수 있지만 다음 달 초는 정확한 날짜가 아니므로 사용자 확인이 필요, timingConfidence=medium.",
      "",
      "추론 예시 4",
      "입력 맥락상 이름스티커도 필요할 수 있음.",
      "출력 방향: itemName=이름스티커, sourceType=ai_suggested, recommendedActionDate=소풍 7일 전의 ISO 날짜, recommendedActionEndDate=null, recommendedActionType=buy, recommendedActionTimingText=6월 5일까지 주문 여부 확인, actionReason=제작·배송 시간이 걸릴 수 있어 일정이 가까워지기 전에 주문 여부를 확인하는 것이 안전, timingConfidence=medium.",
      "",
      "추론 예시 5",
      "입력: 물티슈도 챙겨야 할 듯.",
      "출력 방향: itemName=여분 물티슈, recommendedActionDate=일정 전날의 ISO 날짜, recommendedActionEndDate=일정 당일의 ISO 날짜, recommendedActionType=buy, recommendedActionTimingText=6월 11일~12일 중 구매, actionReason=일반 소모품이라 시기를 놓쳐도 편의점이나 근처 매장에서 비교적 쉽게 살 수 있음, timingConfidence=medium.",
    ].join("\n"),
    input: memo,
    schemaName: "family_purchase_memo_analysis",
    schema,
  });
  let events = normalizeAnalyzedEvents(result.events);
  const eventsMissingSuggestions = events.filter(
    (event) => event.mentionedItems.length && !event.suggestedItems.length,
  );
  if (eventsMissingSuggestions.length) {
    const supplementary = await suggestAdditionalItemsWithOpenAI(
      memo,
      eventsMissingSuggestions,
      todayDate,
    );
    events = mergeSuggestedItems(events, supplementary.events);
  }
  return events;
}

async function suggestAdditionalItemsWithOpenAI(memo, events, todayDate) {
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
            suggestedItems: { type: "array", items: itemSchema() },
          },
          required: ["eventName", "suggestedItems"],
        },
      },
    },
    required: ["events"],
  };

  return callOpenAI({
    instructions: [
      "당신은 가족 일정의 구매 누락을 보완하는 한국어 AI 쇼핑 실행 도우미입니다.",
      `오늘 날짜는 ${todayDate}입니다.`,
      "첫 분석에서 AI 추가 추천 물품이 하나도 나오지 않아 보완 추천을 요청합니다.",
      "제공된 일정 이름을 그대로 사용하고 새로운 일정을 만들지 마세요.",
      "사용자가 이미 언급한 물품을 반복하지 마세요.",
      "각 일정에서 실제 구매 후보로 유용한 물품을 1~3개 적극적으로 검토하세요.",
      "유용한 추가 물품이 있으면 suggestedItems에 sourceType=ai_suggested로 넣으세요.",
      "정말로 추천할 구매 후보가 없을 때만 빈 배열을 반환하세요. 억지 추천은 금지합니다.",
      "AI 권장 액션 시점은 구매, 주문, 비교, 매장 구매 또는 기존 물품 확인 날짜입니다.",
      "recommendedActionTimingText는 구체적인 날짜 범위와 행동을 포함하세요.",
      "실제 배송일이나 재고는 추측하지 마세요.",
    ].join("\n"),
    input: JSON.stringify({ memo, events }, null, 2),
    schemaName: "supplementary_purchase_suggestions",
    schema,
  });
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
      "You recommend up to 3 Korean product candidates for a family purchase task.",
      "Use only products from the crawledProducts JSON. Copy each chosen product title, link, price, and deliveryInfo exactly.",
      "Do not invent delivery dates or availability. If unavailable, keep the provided fallback delivery text.",
      "Do not rank only by popularity. Consider event, needed date, recommended action timing, action reason, notes, and whether delivery data exists.",
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
      itemName: { type: "string" },
      relatedEvent: { type: "string" },
      sourceType: { type: "string", enum: ["user_mentioned", "ai_suggested"] },
      userIntent: { type: "string", enum: ["buy_new", "check_existing", "consider", "unknown"] },
      neededDate: { type: ["string", "null"] },
      neededDateText: { type: "string" },
      recommendedActionTimingText: { type: "string" },
      recommendedActionDate: { type: ["string", "null"] },
      recommendedActionEndDate: { type: ["string", "null"] },
      recommendedActionType: {
        type: "string",
        enum: ["buy", "check", "compare", "prepare_later", "date_needed"],
      },
      actionReason: { type: "string" },
      timingConfidence: { type: "string", enum: ["high", "medium", "low"] },
      dateConfidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: { type: "string" },
      note: { type: "string" },
    },
    required: [
      "itemName",
      "relatedEvent",
      "sourceType",
      "userIntent",
      "neededDate",
      "neededDateText",
      "recommendedActionTimingText",
      "recommendedActionDate",
      "recommendedActionEndDate",
      "recommendedActionType",
      "actionReason",
      "timingConfidence",
      "dateConfidence",
      "reason",
      "note",
    ],
  };
}

function extractionModel() {
  return process.env.OPENAI_MODEL || "gpt-5-mini";
}

function recommendationModel() {
  return (
    process.env.OPENAI_RECOMMEND_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini"
  );
}

async function callOpenAI({ instructions, input, schemaName, schema, model }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || extractionModel(),
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
  const refusal = data.output
    ?.flatMap((entry) => entry.content || [])
    .find((entry) => entry.type === "refusal")
    ?.refusal;
  if (refusal) throw new Error(`OpenAI refused the request: ${refusal}`);

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
  if (!response.ok) throw new Error(`Product search crawl returned ${response.status}`);

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

function normalizeAnalyzedEvents(events = []) {
  const normalizedEvents = events.map((event) => {
    const normalizedEvent = normalizeAnalyzedEvent(event);
    return {
      ...normalizedEvent,
      eventName: normalizedEvent.eventName || "기타 구매",
      mentionedItems: [],
      suggestedItems: [],
    };
  });

  events.forEach((event) => {
    const parentEvent =
      findRelatedEvent(normalizedEvents, event.eventName) ||
      normalizedEvents[0];
    const items = [
      ...(event.mentionedItems || []),
      ...(event.suggestedItems || []),
    ].map(normalizeAnalyzedItem);

    items.forEach((item) => {
      const relatedEventName =
        item.relatedEvent || parentEvent?.eventName || "기타 구매";
      let targetEvent = findRelatedEvent(normalizedEvents, relatedEventName);

      if (!targetEvent) {
        targetEvent = {
          eventName: relatedEventName,
          eventDateText: "날짜 확인 필요",
          eventDate: null,
          eventDateConfidence: "low",
          mentionedItems: [],
          suggestedItems: [],
        };
        normalizedEvents.push(targetEvent);
      }

      const normalizedItem = {
        ...item,
        relatedEvent: targetEvent.eventName,
        neededDate: item.neededDate || targetEvent.eventDate || null,
        neededDateText:
          item.neededDateText ||
          targetEvent.eventDateText ||
          "날짜 확인 필요",
        dateConfidence:
          item.dateConfidence ||
          targetEvent.eventDateConfidence ||
          (item.neededDate || targetEvent.eventDate ? "medium" : "low"),
      };
      if (item.sourceType === "ai_suggested") {
        targetEvent.suggestedItems.push(normalizedItem);
      } else {
        targetEvent.mentionedItems.push(normalizedItem);
      }
    });
  });

  return normalizedEvents.filter(
    (event) => event.mentionedItems.length || event.suggestedItems.length,
  );
}

function normalizeAnalyzedEvent(event) {
  const ambiguousDateText = getAmbiguousDateText(
    `${event.eventName || ""} ${event.eventDateText || ""}`,
  );
  if (!ambiguousDateText) return event;
  return {
    ...event,
    eventDateText: `${ambiguousDateText} · 날짜 확인 필요`,
    eventDate: null,
    eventDateConfidence: "low",
  };
}

function getAmbiguousDateText(value) {
  return (
    String(value || "").match(
      /(?:다음|이번|저번)?\s*(?:달|월)\s*(?:초|중순|말)|날짜\s*(?:미정|확인\s*필요)|언젠가|무렵|쯤|(?:일정|소풍|생신)\s*전\b/i,
    )?.[0] || ""
  );
}

function mergeSuggestedItems(events, supplementaryEvents = []) {
  supplementaryEvents.forEach((supplementaryEvent) => {
    const targetEvent = findRelatedEvent(events, supplementaryEvent.eventName);
    if (!targetEvent) return;

    const existingNames = new Set(
      [...targetEvent.mentionedItems, ...targetEvent.suggestedItems].map(
        (item) => normalizeItemName(item.itemName),
      ),
    );
    (supplementaryEvent.suggestedItems || []).forEach((item) => {
      const normalizedName = normalizeItemName(item.itemName);
      if (!normalizedName || existingNames.has(normalizedName)) return;
      existingNames.add(normalizedName);
      targetEvent.suggestedItems.push(
        normalizeAnalyzedItem({
          ...item,
          relatedEvent: targetEvent.eventName,
          sourceType: "ai_suggested",
        }),
      );
    });
  });
  return events;
}

function findRelatedEvent(events, eventName) {
  return events.find((event) =>
    eventNamesReferToSameEvent(event.eventName, eventName),
  );
}

function eventNamesReferToSameEvent(left, right) {
  const normalizedLeft = normalizeEventName(left);
  const normalizedRight = normalizeEventName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function normalizeEventName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function normalizeItemName(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeAnalyzedItem(item) {
  const recommendedActionDate = item.recommendedActionDate || null;
  const recommendedActionEndDate = item.recommendedActionEndDate || null;
  return {
    ...item,
    recommendedActionDate,
    recommendedActionEndDate,
    recommendedActionTimingText: formatRecommendedActionTiming({
      ...item,
      recommendedActionDate,
      recommendedActionEndDate,
    }),
  };
}

function formatRecommendedActionTiming(item) {
  const action = {
    buy: "구매 후보 보기",
    check: "기존 물품 상태 확인",
    compare: "후보 비교",
    prepare_later: "구매 또는 준비",
    date_needed: "필요 날짜 입력",
  }[item.recommendedActionType] || "구매 후보 보기";
  const start = item.recommendedActionDate;
  const end = item.recommendedActionEndDate;

  if (start && end && start !== end)
    return `${formatKoreanShortDate(start)}~${formatKoreanShortDate(end)} 중 ${action}`;
  if (start) return `${formatKoreanShortDate(start)}까지 ${action}`;
  return (
    item.recommendedActionTimingText ||
    "필요 날짜 입력 후 AI 권장 액션 시점 확인"
  );
}

function formatKoreanShortDate(isoDate) {
  const [, month, day] = String(isoDate).split("-");
  if (!month || !day) return isoDate;
  return `${Number(month)}월 ${Number(day)}일`;
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
  const actionTiming = item.recommendedActionTimingText || (
    item.recommendedActionDate
      ? `AI 권장 액션 날짜 ${item.recommendedActionDate}`
      : "AI 권장 액션 시점 확인 전"
  );
  return products.slice(0, 3).map((product) => ({
    ...product,
    reason: `${item.eventName || "관련 일정"}에 필요한 ${item.name} 후보예요. ${actionTiming}을 참고해 배송 조건을 상품 페이지에서 확인해 주세요.`,
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
    recommendedActionTimingText: String(
      value.recommendedActionTimingText ||
        value.suggestedActionTimingText ||
        value.purchaseDeadlineText ||
        "",
    ).slice(0, 500),
    recommendedActionDate:
      value.recommendedActionDate ||
      value.suggestedActionStartDate ||
      value.suggestedActionDate ||
      value.purchaseDeadline ||
      null,
    recommendedActionEndDate:
      value.recommendedActionEndDate ||
      value.suggestedActionEndDate ||
      value.suggestedActionDate ||
      value.purchaseDeadline ||
      null,
    recommendedActionType: String(
      value.recommendedActionType || inferRecommendedActionType(value),
    ).slice(0, 40),
    actionReason: String(value.actionReason || value.timingReason || "").slice(
      0,
      800,
    ),
    note: String(value.note || "").slice(0, 500),
  };
}

function inferRecommendedActionType(item = {}) {
  if (item.userIntent === "check_existing") return "check";
  if (item.userIntent === "consider") return "compare";
  return item.neededDate ? "buy" : "date_needed";
}

function createDemoAnalysis() {
  const picnicDate = addCalendarDays(getTodayDate(), 6);
  return normalizeAnalyzedEvents([
    {
      eventName: "지우 유치원 소풍",
      eventDateText: "다음 주 금요일",
      eventDate: picnicDate,
      eventDateConfidence: "high",
      mentionedItems: [
        demoItem({
          itemName: "도시락통",
          relatedEvent: "지우 유치원 소풍",
          sourceType: "user_mentioned",
          userIntent: "buy_new",
          neededDate: picnicDate,
          neededDateText: "소풍 당일",
          recommendedActionDate: addCalendarDays(picnicDate, -5),
          recommendedActionEndDate: addCalendarDays(picnicDate, -3),
          recommendedActionType: "buy",
          recommendedActionTimingText: `${formatKoreanShortDate(
            addCalendarDays(picnicDate, -5),
          )}~${formatKoreanShortDate(
            addCalendarDays(picnicDate, -3),
          )} 중 구매 후보 보기`,
          actionReason: "배송 후 세척하고 아이가 혼자 열고 닫기 쉬운지 확인할 시간이 필요할 수 있어요.",
          timingConfidence: "medium",
          dateConfidence: "high",
          reason: "새로 사야 한다고 직접 언급한 준비물이에요.",
          note: "가볍고 아이가 열기 쉬운지 확인",
        }),
        demoItem({
          itemName: "물통",
          relatedEvent: "지우 유치원 소풍",
          sourceType: "user_mentioned",
          userIntent: "check_existing",
          neededDate: picnicDate,
          neededDateText: "소풍 당일",
          recommendedActionDate: addCalendarDays(picnicDate, -5),
          recommendedActionEndDate: null,
          recommendedActionType: "check",
          recommendedActionTimingText: `${formatKoreanShortDate(
            addCalendarDays(picnicDate, -5),
          )}까지 기존 물통 상태 확인`,
          actionReason: "구매보다 보유한 물통의 상태를 확인하는 것이 우선이에요.",
          timingConfidence: "high",
          dateConfidence: "high",
          reason: "상태를 확인해야 한다고 직접 언급한 준비물이에요.",
          note: "필요한 경우에만 새로 구매",
        }),
      ],
      suggestedItems: [
        demoItem({
          itemName: "이름 스티커",
          relatedEvent: "지우 유치원 소풍",
          sourceType: "ai_suggested",
          userIntent: "consider",
          neededDate: picnicDate,
          neededDateText: "소풍 당일",
          recommendedActionDate: addCalendarDays(picnicDate, -8),
          recommendedActionEndDate: addCalendarDays(picnicDate, -7),
          recommendedActionType: "buy",
          recommendedActionTimingText: `${formatKoreanShortDate(
            addCalendarDays(picnicDate, -8),
          )}~${formatKoreanShortDate(
            addCalendarDays(picnicDate, -7),
          )} 중 주문 여부 확인`,
          actionReason: "이름 스티커는 제작과 배송 시간이 걸릴 수 있어 일정이 가까워지기 전에 확인하는 것이 안전해요.",
          timingConfidence: "medium",
          dateConfidence: "high",
          reason: "준비물이 섞이지 않도록 표시할 때 쓸 수 있어요.",
          note: "집에 남은 수량 확인",
        }),
      ],
    },
    {
      eventName: "엄마 생신",
      eventDateText: "다음 달 초",
      eventDate: null,
      eventDateConfidence: "low",
      mentionedItems: [
        demoItem({
          itemName: "엄마 생신 선물",
          relatedEvent: "엄마 생신",
          sourceType: "user_mentioned",
          userIntent: "consider",
          neededDate: null,
          neededDateText: "다음 달 초 · 날짜 확인 필요",
          recommendedActionTimingText: "생신 날짜 입력 후 최소 7일 전부터 선물 후보 비교",
          recommendedActionType: "date_needed",
          actionReason: "선물은 비교, 배송, 포장 시간이 필요할 수 있지만 정확한 생신 날짜를 먼저 확인해야 해요.",
          timingConfidence: "medium",
          dateConfidence: "low",
          reason: "미리 알아봐야 한다고 직접 언급한 선물이에요.",
          note: "취향과 예산 정하기",
        }),
      ],
      suggestedItems: [],
    },
  ]);
}

function demoItem(item) {
  return {
    neededDate: null,
    neededDateText: "날짜 확인 필요",
    recommendedActionDate: null,
    recommendedActionEndDate: null,
    recommendedActionType: "date_needed",
    ...item,
  };
}

function getTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addCalendarDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// AI 상품 찾기: 네이버 쇼핑 API + 경량 크롤링 + OpenAI 후보 추천 파이프라인
// ---------------------------------------------------------------------------

const broadItemTerms = ["선물", "옷", "신발", "가방", "장난감", "생신", "집들이", "용품"];
const recommendationLabels = ["가장 먼저 볼 후보", "가성비 후보", "신중히 볼 후보"];

function sanitizeProductItem(value = {}) {
  const itemName = String(value.itemName || value.name || "").slice(0, 120);
  return {
    itemName,
    relatedEvent: String(value.relatedEvent || value.eventName || "").slice(0, 160),
    neededDate: value.neededDate || null,
    recommendedActionTimingText: String(
      value.recommendedActionTimingText || "",
    ).slice(0, 500),
    recommendedActionType: String(value.recommendedActionType || "").slice(0, 40),
    actionReason: String(value.actionReason || value.reason || "").slice(0, 800),
    note: String(value.note || "").slice(0, 500),
    userIntent: String(value.userIntent || "unknown").slice(0, 40),
  };
}

function sanitizeUserConstraints(value = {}) {
  const toList = (input) =>
    (Array.isArray(input) ? input : String(input || "").split(/[,\n]/))
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .slice(0, 10);
  return {
    budget: String(value.budget || "").slice(0, 120),
    recipient: String(value.recipient || "").slice(0, 120),
    preferences: toList(value.preferences),
    avoid: toList(value.avoid),
  };
}

function hasUserConstraints(constraints = {}) {
  return Boolean(
    constraints.budget ||
      constraints.recipient ||
      constraints.preferences?.length ||
      constraints.avoid?.length,
  );
}

async function buildSearchPlan(item, userConstraints) {
  if (!process.env.OPENAI_API_KEY) {
    return createDemoSearchPlan(item, userConstraints);
  }
  try {
    return await generateSearchPlanWithOpenAI(item, userConstraints);
  } catch (error) {
    console.warn("Search plan generation failed, using heuristic:", error.message);
    return createDemoSearchPlan(item, userConstraints);
  }
}

async function generateSearchPlanWithOpenAI(item, userConstraints) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      refinedSearchQueries: { type: "array", items: { type: "string" }, maxItems: 6 },
      recommendationCriteria: { type: "array", items: { type: "string" } },
      avoidCriteria: { type: "array", items: { type: "string" } },
      needsMoreInfo: { type: "boolean" },
      followUpQuestions: { type: "array", items: { type: "string" } },
    },
    required: [
      "refinedSearchQueries",
      "recommendationCriteria",
      "avoidCriteria",
      "needsMoreInfo",
      "followUpQuestions",
    ],
  };

  const plan = await callOpenAI({
    instructions: [
      "당신은 한국어 가족 구매 도우미의 상품 검색 전략가입니다.",
      "사용자 물품 맥락(item)과 보완 조건(userConstraints)을 보고 네이버 쇼핑 검색에 쓸 전략을 만드세요.",
      "refinedSearchQueries는 네이버 쇼핑에서 잘 검색되는 한국어 검색어 2~5개입니다. 일정과 대상, 사용 맥락을 반영해 구체화하세요.",
      "recommendationCriteria는 이 사용자 상황에서 좋은 후보를 고르는 기준입니다. note, actionReason, userIntent를 반영하세요.",
      "avoidCriteria는 피해야 할 후보의 특징입니다.",
      "물품명이 '생신 선물', '집들이 선물', '옷', '신발', '가방', '장난감'처럼 너무 넓어 검색어를 구체화하기 어렵고 보완 조건도 비어 있으면 needsMoreInfo=true로 두고 followUpQuestions에 예산, 대상, 선호, 피하고 싶은 조건을 묻는 짧은 질문을 넣으세요.",
      "보완 조건(userConstraints)에 예산, 대상, 선호, 피할 조건이 하나라도 있으면 needsMoreInfo=false로 두고 그 정보를 검색어와 기준에 반영하세요.",
      "충분히 구체적인 물품이면 needsMoreInfo=false, followUpQuestions=[]로 두세요.",
      "실제 상품이나 배송일을 상상하지 마세요. 여기서는 검색 전략만 만듭니다.",
    ].join("\n"),
    input: JSON.stringify({ item, userConstraints }, null, 2),
    schemaName: "product_search_plan",
    schema,
    model: recommendationModel(),
  });

  return {
    refinedSearchQueries: (plan.refinedSearchQueries || []).filter(Boolean),
    recommendationCriteria: plan.recommendationCriteria || [],
    avoidCriteria: plan.avoidCriteria || [],
    needsMoreInfo: Boolean(plan.needsMoreInfo),
    followUpQuestions: plan.followUpQuestions || [],
  };
}

function createDemoSearchPlan(item, userConstraints) {
  const needsMoreInfo =
    !hasUserConstraints(userConstraints) &&
    broadItemTerms.some((term) => item.itemName.includes(term));
  const queries = buildDemoQueries(item, userConstraints);
  return {
    refinedSearchQueries: queries,
    recommendationCriteria: [
      "메모 맥락과 사용 목적에 맞는 제품",
      "가격이 과하지 않은 제품",
      item.note ? `비고 반영: ${item.note}` : "일정 전에 준비 가능한 제품",
    ].filter(Boolean),
    avoidCriteria: ["사용 맥락과 맞지 않는 제품", "구조가 복잡하거나 과한 제품"],
    needsMoreInfo,
    followUpQuestions: needsMoreInfo
      ? ["예산, 대상, 선호, 피하고 싶은 조건을 알려주시면 더 잘 찾을 수 있어요."]
      : [],
  };
}

function buildDemoQueries(item, userConstraints) {
  const base = item.itemName.trim();
  const prefixes = [];
  if (userConstraints.recipient) prefixes.push(userConstraints.recipient);
  (userConstraints.preferences || []).slice(0, 2).forEach((pref) => prefixes.push(pref));
  const queries = [base];
  prefixes.forEach((prefix) => queries.push(`${prefix} ${base}`.trim()));
  return [...new Set(queries.filter(Boolean))].slice(0, 5);
}

async function searchProductsWithPlan(searchPlan, item) {
  const queries = searchPlan.refinedSearchQueries.length
    ? searchPlan.refinedSearchQueries
    : [item.itemName];

  let candidates = await searchNaverShopping(queries[0], 10).catch((error) => {
    console.warn("Naver shopping search failed:", error.message);
    return [];
  });

  if (candidates.length < 3 && queries[1]) {
    const more = await searchNaverShopping(queries[1], 10).catch(() => []);
    candidates = dedupeByLink([...candidates, ...more]);
  }
  return candidates;
}

async function searchNaverShopping(query, display = 10) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(
    query,
  )}&display=${display}&sort=sim`;
  const apiResponse = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET,
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Naver shopping API ${apiResponse.status}: ${body.slice(0, 300)}`);
  }
  const data = await apiResponse.json();
  return (data.items || []).map(normalizeNaverItem);
}

function normalizeNaverItem(raw = {}) {
  const category = [raw.category1, raw.category2, raw.category3, raw.category4]
    .filter(Boolean)
    .join(" > ");
  const price = Number(raw.lprice) || Number(raw.hprice) || null;
  return {
    title: stripHtml(raw.title),
    price,
    mallName: raw.mallName || "",
    source: "naver_shopping",
    link: raw.link || "",
    image: raw.image || "",
    brand: raw.brand || raw.maker || "",
    category,
    productId: raw.productId || "",
    deliveryText: null,
    crawledInfo: { status: "pending" },
  };
}

function stripHtml(value = "") {
  return cleanText(String(value).replace(/<[^>]*>/g, ""))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function dedupeByLink(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.link || seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
}

const crawlUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, run),
  );
  return results;
}

// 최종 추천 상품(최대 3~5개)에 대해서만 가벼운 정적 크롤링으로 공개 메타데이터를 수집한다.
// 네이버 스마트스토어 등은 봇 요청을 차단하므로 배송 정보는 대부분 얻지 못하며,
// 그 경우 UI에서 사용자가 상세 페이지에서 직접 확인하도록 안내한다.
async function crawlLinksForDelivery(links) {
  const uniqueLinks = [...new Set((links || []).filter(Boolean))].slice(0, 5);
  const deliveryByLink = new Map();
  if (!uniqueLinks.length) return deliveryByLink;

  await mapWithConcurrency(uniqueLinks, 3, async (link) => {
    const info = await crawlProductPage(link);
    deliveryByLink.set(link, {
      deliveryText: info.deliveryText || null,
      status: info.status,
    });
  });

  return deliveryByLink;
}

async function crawlProductPage(link) {
  if (!link) return { status: "failed" };
  try {
    const pageResponse = await fetch(link, {
      headers: {
        "User-Agent": crawlUserAgent,
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!pageResponse.ok) return { status: "failed" };

    const html = await pageResponse.text();
    const $ = cheerio.load(html);
    const pageTitle = cleanText($("title").first().text()).slice(0, 200);
    const metaDescription = cleanText(
      $('meta[name="description"]').attr("content") || "",
    ).slice(0, 300);
    const ogTitle = cleanText($('meta[property="og:title"]').attr("content") || "").slice(0, 200);
    const ogDescription = cleanText(
      $('meta[property="og:description"]').attr("content") || "",
    ).slice(0, 300);
    const bodyText = cleanText($("body").text());
    const pageSnippet = bodyText.slice(0, 300);
    const deliveryText = extractDeliveryFromText(
      `${metaDescription} ${ogDescription} ${bodyText.slice(0, 4000)}`,
    );

    return {
      status: "success",
      pageTitle,
      metaDescription,
      ogTitle,
      ogDescription,
      pageSnippet,
      deliveryText,
    };
  } catch {
    return { status: "failed" };
  }
}

function extractDeliveryFromText(text) {
  const value = String(text);
  const patterns = [
    /오늘\s*출발/,
    /당일\s*(?:발송|배송|출발)/,
    /내일\s*도착/,
    /모레\s*도착/,
    /새벽\s*배송/,
    /도착\s*보장/,
    /평균\s*\d+\s*일\s*이내\s*도착/,
    /\d+\.\d+\s*\([월화수목금토일]\)\s*발송\s*예정/,
    /무료\s*배송/,
    /빠른\s*배송/,
    /해외\s*배송/,
    /예약\s*배송/,
    /주문\s*제작/,
    /배송비\s*[\d,]+\s*원/,
  ];
  const found = [];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const phrase = cleanText(match[0]);
      if (phrase && !found.includes(phrase)) found.push(phrase);
    }
    if (found.length >= 3) break;
  }
  return found.length ? found.join(" · ") : null;
}

function filterCandidates(candidates, searchPlan, item) {
  const seenTitles = new Set();
  const valid = candidates.filter((candidate) => {
    const titleKey = normalizeItemName(candidate.title);
    if (!candidate.title || !candidate.link || !titleKey) return false;
    if (seenTitles.has(titleKey)) return false;
    seenTitles.add(titleKey);
    return true;
  });

  const withPrice = valid.filter((candidate) => candidate.price);
  const ranked = withPrice.length >= 3 ? withPrice : valid;

  const keywords = buildKeywords(item, searchPlan);
  const relevant = ranked.filter((candidate) =>
    keywords.some((keyword) => candidate.title.includes(keyword)),
  );

  if (relevant.length >= 3) {
    return { filtered: relevant.slice(0, 10), relaxedFilter: false };
  }
  return {
    filtered: ranked.slice(0, 10),
    relaxedFilter: relevant.length < ranked.length,
  };
}

function buildKeywords(item, searchPlan) {
  const tokens = new Set();
  const collect = (value) =>
    String(value || "")
      .split(/\s+/)
      .forEach((token) => {
        if (token.length >= 2) tokens.add(token);
      });
  collect(item.itemName);
  (searchPlan.refinedSearchQueries || []).forEach(collect);
  return [...tokens];
}

async function buildRecommendations(item, searchPlan, candidates) {
  if (!process.env.OPENAI_API_KEY) {
    return recommendCandidatesForDemo(item, candidates);
  }
  const result = await recommendProductsFromCandidatesWithOpenAI(
    item,
    searchPlan,
    candidates,
  );
  const recommendations = reconcileRecommendations(result.recommendations, candidates);
  return {
    summary: result.summary,
    recommendations,
    limitations: result.limitations,
  };
}

async function recommendProductsFromCandidatesWithOpenAI(item, searchPlan, candidates) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      recommendations: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rank: { type: "number" },
            label: {
              type: "string",
              enum: recommendationLabels,
            },
            title: { type: "string" },
            price: { type: ["number", "null"] },
            mallName: { type: "string" },
            source: { type: "string" },
            link: { type: "string" },
            image: { type: "string" },
            deliveryInfo: { type: ["string", "null"] },
            fitReason: { type: "string" },
            caution: { type: "string" },
            matchedCriteria: { type: "array", items: { type: "string" } },
          },
          required: [
            "rank",
            "label",
            "title",
            "price",
            "mallName",
            "source",
            "link",
            "image",
            "deliveryInfo",
            "fitReason",
            "caution",
            "matchedCriteria",
          ],
        },
      },
      limitations: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "recommendations", "limitations"],
  };

  return callOpenAI({
    instructions: [
      "당신은 한국어 가족 구매 도우미의 상품 추천가입니다.",
      "item context, 추천 기준, 그리고 수집된 상품 후보(productCandidates)를 보고 최대 3개를 추천하세요.",
      "반드시 productCandidates 안에 있는 상품만 추천하세요. 새 상품을 상상하거나 만들지 마세요.",
      "각 추천의 link는 후보의 link와 정확히 같아야 합니다.",
      "title, price, mallName, source, image, deliveryInfo는 해당 후보의 값을 그대로 복사하세요.",
      "deliveryInfo는 후보의 deliveryText 또는 crawledInfo에서 확인된 값만 사용하고, 확인할 수 없으면 null로 두세요. 배송일을 추측하지 마세요.",
      "label은 '가장 먼저 볼 후보', '가성비 후보', '신중히 볼 후보' 중에서 고르세요.",
      "fitReason은 관련 일정, 필요 날짜, AI 권장 액션 시점, 비고, 사용자 의도, 배송 정보 확인 가능 여부 중 실제로 관련된 맥락을 반영해 구체적으로 쓰세요. '좋아 보입니다' 같은 막연한 표현은 금지합니다.",
      "matchedCriteria는 recommendationCriteria 중 이 후보가 충족하는 항목을 골라 담으세요.",
      "summary는 이 물품을 고를 때 먼저 봐야 할 점을 한두 문장으로 설명하세요.",
      "limitations에는 배송 보장 불가, 제한된 데이터 기반 추천이라는 점을 한국어로 담으세요.",
    ].join("\n"),
    input: JSON.stringify(
      {
        item,
        refinedSearchQueries: searchPlan.refinedSearchQueries,
        recommendationCriteria: searchPlan.recommendationCriteria,
        avoidCriteria: searchPlan.avoidCriteria,
        productCandidates: candidates.map(toModelCandidate),
      },
      null,
      2,
    ),
    schemaName: "product_recommendations_v2",
    schema,
    model: recommendationModel(),
  });
}

function reconcileRecommendations(recommendations = [], candidates = []) {
  const byLink = new Map(candidates.map((candidate) => [candidate.link, candidate]));
  return recommendations
    .map((recommendation) => {
      const match = byLink.get(recommendation.link);
      if (!match) return null;
      return {
        ...recommendation,
        title: match.title,
        price: match.price,
        mallName: match.mallName,
        source: match.source,
        image: match.image,
        link: match.link,
        deliveryInfo: match.deliveryText,
        crawlStatus: match.crawledInfo?.status || "unknown",
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function recommendCandidatesForDemo(item, candidates) {
  const top = candidates.slice(0, 3);
  return {
    summary: `${item.itemName} 후보를 수집했어요. OpenAI 키가 없어 수집 순서를 기준으로 정리했습니다.`,
    recommendations: top.map((candidate, index) => ({
      rank: index + 1,
      label: recommendationLabels[index] || "후보",
      title: candidate.title,
      price: candidate.price,
      mallName: candidate.mallName,
      source: candidate.source,
      link: candidate.link,
      image: candidate.image,
      deliveryInfo: candidate.deliveryText,
      crawlStatus: candidate.crawledInfo?.status || "unknown",
      fitReason: `${item.relatedEvent || "관련 일정"}에 쓸 ${item.itemName} 후보예요. ${
        item.recommendedActionTimingText || "권장 액션 시점"
      }을 참고해 상세페이지에서 조건을 확인해 주세요.`,
      caution: candidate.deliveryText
        ? "상세페이지에서 옵션과 실제 도착 예정일을 다시 확인해 주세요."
        : "배송 정보를 확인하지 못했어요. 결제 전에 도착 가능일을 꼭 확인해 주세요.",
      matchedCriteria: [],
    })),
    limitations: [
      "배송일은 판매처별로 달라 정확히 보장할 수 없습니다.",
      "추천은 네이버 쇼핑 API와 제한적 크롤링 데이터 기반입니다.",
    ],
  };
}

function toModelCandidate(candidate) {
  const crawledInfo =
    candidate.crawledInfo?.status === "success"
      ? {
          status: "success",
          pageTitle: candidate.crawledInfo.pageTitle,
          metaDescription: candidate.crawledInfo.metaDescription,
          ogTitle: candidate.crawledInfo.ogTitle,
          ogDescription: candidate.crawledInfo.ogDescription,
          pageSnippet: candidate.crawledInfo.pageSnippet,
        }
      : { status: candidate.crawledInfo?.status || "failed" };
  return {
    title: candidate.title,
    price: candidate.price,
    mallName: candidate.mallName,
    source: candidate.source,
    link: candidate.link,
    image: candidate.image,
    brand: candidate.brand,
    category: candidate.category,
    deliveryText: candidate.deliveryText,
    crawledInfo,
  };
}

function toPublicCandidate(candidate) {
  return {
    title: candidate.title,
    price: candidate.price,
    mallName: candidate.mallName,
    source: candidate.source,
    link: candidate.link,
    image: candidate.image,
    brand: candidate.brand,
    category: candidate.category,
    deliveryText: candidate.deliveryText,
    crawlStatus: candidate.crawledInfo?.status || "unknown",
  };
}

function createMockCandidates(item, searchPlan) {
  const query = searchPlan.refinedSearchQueries[0] || item.itemName;
  const searchLink = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(
    query,
  )}`;
  return [1, 2, 3].map((index) => ({
    title: `${item.itemName} 예시 후보 ${index}`,
    price: 9900 * index,
    mallName: "예시몰",
    source: "mock",
    link: `${searchLink}&example=${index}`,
    image: "",
    brand: "",
    category: "",
    productId: `mock-${index}`,
    deliveryText: index === 1 ? "무료배송" : null,
    crawledInfo: { status: "skipped" },
  }));
}
