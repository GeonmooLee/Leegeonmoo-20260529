import { useEffect, useMemo, useState } from "react";
import { useRouter } from "./router.js";

const LEGACY_MEMO_ID = "memo-legacy";
const sourceLabels = {
  mentioned: "사용자 언급 물품",
  suggested: "AI 추가 추천 물품",
  manual: "직접 추가",
};
const userIntentLabels = {
  buy_new: "새로 구매하기",
  check_existing: "집에 있는 물품 상태 확인",
  consider: "후보를 비교해 보기",
  prepare: "필요 여부를 확인하고 준비",
  unknown: "메모 내용을 확인해 주세요",
};
const recommendedActionTypeLabels = {
  buy: "구매 후보 보기",
  check: "기존 물품 상태 확인",
  compare: "후보 비교",
  prepare_later: "구매 또는 준비",
  date_needed: "필요 날짜 입력",
};

function uid(prefix = "item") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStored(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function useStoredState(key, initialValue, transform = (saved) => saved) {
  const [value, setValue] = useState(() => {
    const fallback =
      typeof initialValue === "function" ? initialValue() : initialValue;
    return transform(readStored(key, fallback));
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function createLegacyMemos() {
  const content = readStored("salddeut.memo", "");
  if (!content?.trim()) return [];

  return [
    {
      id: LEGACY_MEMO_ID,
      title: makeMemoTitle(content),
      content,
      createdAt: new Date().toISOString(),
    },
  ];
}

function createLegacyAnalyses() {
  const items = readStored("salddeut.suggestions", []);
  if (!items.length) return {};

  const eventNames = readStored("salddeut.suggestionEvents", []);
  const meta = readStored("salddeut.analysisMeta", {});
  return {
    [LEGACY_MEMO_ID]: {
      memoId: LEGACY_MEMO_ID,
      eventNames: eventNames.length
        ? eventNames
        : [...new Set(items.map((item) => item.eventName || "기타 구매"))],
      items,
      analyzedAt: meta?.createdAt || new Date().toISOString(),
      demoMode: Boolean(meta?.demoMode),
    },
  };
}

function createLegacyShoppingList() {
  return readStored("salddeut.purchaseList", []).map((item) => ({
    ...item,
    sourceMemoId: item.sourceMemoId || LEGACY_MEMO_ID,
    analysisItemId: item.analysisItemId || item.suggestionId || null,
  }));
}

function makeMemoTitle(content) {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "제목 없는 메모";
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}...` : firstLine;
}

function formatDate(value) {
  if (!value) return "날짜 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00`));
}

function formatCreatedAt(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function toInputDate(value) {
  return value || "";
}

function normalize(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function eventNamesReferToSameEvent(left, right) {
  const normalizedLeft = normalize(left).replace(/[^\p{L}\p{N}]/gu, "");
  const normalizedRight = normalize(right).replace(/[^\p{L}\p{N}]/gu, "");
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function getAmbiguousDateText(value) {
  return (
    String(value || "").match(
      /(?:다음|이번|저번)?\s*(?:달|월)\s*(?:초|중순|말)|날짜\s*(?:미정|확인\s*필요)|언젠가|무렵|쯤|(?:일정|소풍|생신)\s*전\b/i,
    )?.[0] || ""
  );
}

function sanitizeEventMeta(eventMeta = {}, fallbackEventName = "기타 구매") {
  const eventName = eventMeta.eventName || fallbackEventName;
  const ambiguousDateText = getAmbiguousDateText(
    `${eventName} ${eventMeta.eventDateText || ""}`,
  );
  if (!ambiguousDateText) return { ...eventMeta, eventName };

  return {
    ...eventMeta,
    eventName,
    eventDateText: `${ambiguousDateText} · 날짜 확인 필요`,
    eventDate: null,
    eventDateConfidence: "low",
  };
}

async function parseApiResponse(response, fallbackMessage) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      `${fallbackMessage} 서버 응답이 비어 있습니다. 잠시 후 다시 시도해 주세요.`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${fallbackMessage} 서버 응답 형식을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.`,
    );
  }
}

function normalizeAnalysisItem(item, event, sourceType) {
  const {
    priority: _priority,
    purchaseDeadline: _purchaseDeadline,
    purchaseDeadlineText: _purchaseDeadlineText,
    deadlineReason: _deadlineReason,
    suggestedActionStartDate: _suggestedActionStartDate,
    suggestedActionEndDate: _suggestedActionEndDate,
    suggestedActionDate: _suggestedActionDate,
    suggestedActionTimingText: _suggestedActionTimingText,
    timingReason: _timingReason,
    ...currentItem
  } = item;
  const name = item.name || item.itemName || "";
  const eventName =
    item.eventName || item.relatedEvent || event.eventName || "기타 구매";
  const inheritsEventDate = eventNamesReferToSameEvent(
    eventName,
    event.eventName,
  );
  const neededDate =
    item.neededDate || (inheritsEventDate ? event.eventDate : null) || null;
  const neededDateText =
    item.neededDateText ||
    (inheritsEventDate ? event.eventDateText : null) ||
    "날짜 확인 필요";
  const recommendedActionDate =
    item.recommendedActionDate ||
    item.suggestedActionStartDate ||
    item.suggestedActionDate ||
    item.purchaseDeadline ||
    null;
  const recommendedActionEndDate =
    item.recommendedActionEndDate ||
    item.suggestedActionEndDate ||
    item.suggestedActionDate ||
    item.purchaseDeadline ||
    null;
  const recommendedActionTimingText =
    item.recommendedActionTimingText ||
    item.suggestedActionTimingText ||
    item.purchaseDeadlineText ||
    "";

  return {
    ...currentItem,
    name,
    itemName: name,
    eventName,
    relatedEvent: eventName,
    analysisSourceType: item.analysisSourceType || item.sourceType,
    sourceType,
    userIntent: item.userIntent || "unknown",
    userIntentText:
      item.userIntentText ||
      userIntentLabels[item.userIntent] ||
      item.reason ||
      "",
    neededDate,
    neededDateText,
    dateConfidence:
      item.dateConfidence ||
      event.eventDateConfidence ||
      (neededDate ? "medium" : "low"),
    timingConfidence: item.timingConfidence || "low",
    recommendedActionDate,
    recommendedActionEndDate,
    recommendedActionTimingText,
    recommendedActionType:
      item.recommendedActionType || inferRecommendedActionType(item),
    actionReason: item.actionReason || item.timingReason || item.reason || "",
  };
}

function inferRecommendedActionType(item = {}) {
  if (item.userIntent === "check_existing") return "check";
  if (item.userIntent === "consider") return "compare";
  return item.neededDate ? "buy" : "date_needed";
}

function migrateAnalyses(analyses = {}) {
  return Object.fromEntries(
    Object.entries(analyses).map(([memoId, analysis]) => [
      memoId,
      {
        ...analysis,
        items: (analysis.items || []).map((item) =>
          normalizeAnalysisItem(
            item,
            {
              eventName: item.eventName,
              eventDate: item.neededDate,
              eventDateText: item.neededDateText,
              eventDateConfidence: item.dateConfidence,
            },
            item.sourceType || "mentioned",
          ),
        ),
      },
    ]),
  );
}

function migrateShoppingList(items = []) {
  return items.map((item) =>
    normalizeAnalysisItem(
      item,
      {
        eventName: item.eventName,
        eventDate: item.neededDate,
        eventDateText: item.neededDateText,
        eventDateConfidence: item.dateConfidence,
      },
      item.sourceType || "manual",
    ),
  );
}

function createEventMeta(event) {
  return sanitizeEventMeta({
    eventName: event.eventName || "기타 구매",
    eventDateText: event.eventDateText || "날짜 확인 필요",
    eventDate: event.eventDate || null,
    eventDateConfidence:
      event.eventDateConfidence || (event.eventDate ? "medium" : "low"),
  });
}

function getEventMeta(analysis, eventName, items = []) {
  const saved = analysis.eventMetaByName?.[eventName];
  if (saved) return sanitizeEventMeta(saved, eventName);
  const relatedSaved = Object.values(analysis.eventMetaByName || {}).find(
    (eventMeta) =>
      eventNamesReferToSameEvent(eventMeta.eventName, eventName),
  );
  if (relatedSaved) return sanitizeEventMeta(relatedSaved, eventName);
  if (analysis.eventMetaByName) {
    return {
      eventName,
      eventDateText: "날짜 확인 필요",
      eventDate: null,
      eventDateConfidence: "low",
    };
  }

  const firstItem = items[0] || {};
  return sanitizeEventMeta({
    eventName,
    eventDateText: firstItem.neededDateText || "날짜 확인 필요",
    eventDate: firstItem.neededDate || null,
    eventDateConfidence:
      firstItem.dateConfidence || (firstItem.neededDate ? "medium" : "low"),
  });
}

function formatEventDate(eventMeta) {
  if (!eventMeta.eventDate)
    return eventMeta.eventDateText || "날짜 확인 필요";
  return eventMeta.eventDateText
    ? `${formatDate(eventMeta.eventDate)} · ${eventMeta.eventDateText}`
    : formatDate(eventMeta.eventDate);
}

function formatNeededDate(item) {
  if (!item.neededDate) return item.neededDateText || "날짜 확인 필요";
  const context = item.neededDateText;
  return context
    ? `${formatDate(item.neededDate)} · ${context}`
    : formatDate(item.neededDate);
}

function getRecommendedActionTiming(item) {
  return (
    item.recommendedActionTimingText ||
    (item.recommendedActionDate
      ? `${formatDate(item.recommendedActionDate)}까지 액션 진행`
      : "날짜 입력 필요")
  );
}

function makeEditableActionTiming(item) {
  const action =
    recommendedActionTypeLabels[item.recommendedActionType] || "액션 진행";
  if (
    item.recommendedActionDate &&
    item.recommendedActionEndDate &&
    item.recommendedActionDate !== item.recommendedActionEndDate
  ) {
    return `${formatDate(item.recommendedActionDate)}~${formatDate(
      item.recommendedActionEndDate,
    )} 중 ${action}`;
  }
  const date = item.recommendedActionDate || item.recommendedActionEndDate;
  return date ? `${formatDate(date)}까지 ${action}` : "날짜 입력 필요";
}

function flattenEvents(events = []) {
  return events.flatMap((event) => {
    const mentioned = (event.mentionedItems || []).map((item) => ({
      ...normalizeAnalysisItem(item, event, "mentioned"),
      id: uid("mention"),
    }));
    const suggested = (event.suggestedItems || []).map((item) => ({
      ...normalizeAnalysisItem(item, event, "suggested"),
      id: uid("suggestion"),
    }));
    return [...mentioned, ...suggested];
  });
}

function Field({ label, children, wide = false }) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function ItemEditor({ item, onSave, onCancel }) {
  const [draft, setDraft] = useState(() =>
    normalizeAnalysisItem(
      item,
      {
        eventName: item.eventName,
        eventDate: item.neededDate,
        eventDateText: item.neededDateText,
        eventDateConfidence: item.dateConfidence,
      },
      item.sourceType || "manual",
    ),
  );
  const update = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const updateNeededDate = (value) =>
    setDraft((current) => ({
      ...current,
      neededDate: value || null,
      neededDateText: value
        ? `${formatDate(value)} (직접 입력)`
        : "날짜 확인 필요",
      dateConfidence: value ? "high" : "low",
    }));
  const updateRecommendedActionDate = (key, value) =>
    setDraft((current) => {
      const next = { ...current, [key]: value || null };
      return {
        ...next,
        recommendedActionTimingText: makeEditableActionTiming(next),
      };
    });

  return (
    <div className="editor">
      <div className="editor-grid">
        <Field label="물품명">
          <input
            value={draft.name || ""}
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>
        <Field label="관련 일정">
          <input
            value={draft.eventName || ""}
            onChange={(event) => update("eventName", event.target.value)}
          />
        </Field>
        <Field label="필요 날짜">
          <input
            type="date"
            value={toInputDate(draft.neededDate)}
            onChange={(event) => updateNeededDate(event.target.value)}
          />
        </Field>
        <Field label="액션 시작 날짜">
          <input
            type="date"
            value={toInputDate(draft.recommendedActionDate)}
            onChange={(event) =>
              updateRecommendedActionDate(
                "recommendedActionDate",
                event.target.value,
              )
            }
          />
        </Field>
        <Field label="액션 종료 날짜">
          <input
            type="date"
            value={toInputDate(draft.recommendedActionEndDate)}
            onChange={(event) =>
              updateRecommendedActionDate(
                "recommendedActionEndDate",
                event.target.value,
              )
            }
          />
        </Field>
        <Field label="액션 종류">
          <select
            value={draft.recommendedActionType || "date_needed"}
            onChange={(event) =>
              update("recommendedActionType", event.target.value)
            }
          >
            {Object.entries(recommendedActionTypeLabels).map(
              ([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </Field>
        <Field label="비고" wide>
          <input
            value={draft.note || ""}
            onChange={(event) => update("note", event.target.value)}
            placeholder="선호, 사이즈, 확인할 점"
          />
        </Field>
        <Field label="AI 권장 액션 시점" wide>
          <input
            value={draft.recommendedActionTimingText || ""}
            onChange={(event) =>
              update("recommendedActionTimingText", event.target.value)
            }
            placeholder="예: 6월 1일~3일 중 구매 후보 보기"
          />
        </Field>
        <Field label="권장 이유" wide>
          <input
            value={draft.actionReason || ""}
            onChange={(event) => update("actionReason", event.target.value)}
            placeholder="예: 배송 후 세척과 사용 확인 시간이 필요할 수 있음"
          />
        </Field>
      </div>
      <div className="editor-actions">
        <button
          className="button primary small"
          onClick={() => onSave(draft)}
          disabled={!draft.name?.trim()}
        >
          저장
        </button>
        <button className="button ghost small" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

function Badge({ children, tone = "neutral" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function EmptyState({ title, description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">+</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function MemoCard({
  memo,
  analysis,
  addedItems,
  isLoading,
  onOpenDetail,
  onAnalyze,
  onOpenAnalysis,
  onDelete,
}) {
  const addedCount = addedItems.length;

  return (
    <article
      className="memo-list-card"
      role="link"
      tabIndex="0"
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <div className="memo-list-heading">
        <div>
          <Badge tone={analysis ? "sage" : "apricot"}>
            {analysis ? "분석 완료" : "분석 전"}
          </Badge>
          <h3>{memo.title || makeMemoTitle(memo.content)}</h3>
        </div>
        <time>{formatCreatedAt(memo.createdAt)}</time>
      </div>
      <p className="memo-preview">{memo.content}</p>
      <div className="memo-card-footer">
        {analysis && (
          <span
            className={`memo-added-items ${addedCount ? "has-tooltip" : ""}`}
            tabIndex={addedCount ? 0 : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            쇼핑 리스트에 추가된 물품 <b>{addedCount}</b>개
            {addedCount > 0 && (
              <span className="memo-items-tooltip" role="tooltip">
                <strong>이 메모에서 추가한 물품</strong>
                {addedItems.map((item) => (
                  <span key={item.id}>{item.name}</span>
                ))}
              </span>
            )}
          </span>
        )}
        {!analysis && (
          <span className="memo-added-items is-placeholder" aria-hidden="true">
            쇼핑 리스트에 추가된 물품 0개
          </span>
        )}
        <div className="card-actions">
          {analysis ? (
            <>
              <button
                className="button primary small"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenAnalysis();
                }}
              >
                분석 결과 보기
              </button>
              <button
                className="button ghost small"
                onClick={(event) => {
                  event.stopPropagation();
                  onAnalyze();
                }}
                disabled={isLoading}
              >
                {isLoading ? "분석 중..." : "다시 분석"}
              </button>
            </>
          ) : (
            <button
              className="button primary small"
              onClick={(event) => {
                event.stopPropagation();
                onAnalyze();
              }}
              disabled={isLoading}
            >
              {isLoading ? "AI가 분석하고 있어요..." : "AI로 분석하기"}
            </button>
          )}
          <button
            className="text-button danger memo-delete-button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            disabled={isLoading}
          >
            삭제
          </button>
        </div>
      </div>
    </article>
  );
}

function AnalysisItemCard({ item, existingItem, onAdd, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <article
        className={`suggestion-card source-${item.sourceType} ${
          existingItem ? "is-added" : ""
        }`}
      >
        <div className="card-heading">
          <div>
            <Badge tone={item.sourceType === "suggested" ? "sage" : "apricot"}>
              {sourceLabels[item.sourceType]}
            </Badge>
            <h4>{item.name}</h4>
          </div>
        </div>
        <dl className="mini-details analysis-details">
          {item.sourceType !== "suggested" && (
            <div>
              <dt>사용자 메모 의미</dt>
              <dd>
                {item.userIntentText ||
                  userIntentLabels[item.userIntent] ||
                  item.reason ||
                  "필요 여부를 확인해 주세요."}
              </dd>
            </div>
          )}
          <div>
            <dt>필요 날짜</dt>
            <dd>{formatNeededDate(item)}</dd>
          </div>
          <div>
            <dt>AI 권장 액션 시점</dt>
            <dd>{getRecommendedActionTiming(item)}</dd>
          </div>
          <div>
            <dt>권장 이유</dt>
            <dd>{item.actionReason || item.reason || "확인 필요"}</dd>
          </div>
          <div>
            <dt>비고</dt>
            <dd>{item.note || "-"}</dd>
          </div>
        </dl>
        <div className="card-actions analysis-card-actions">
          {existingItem ? (
            <button className="button disabled small" disabled>
              이미 쇼핑 리스트에 있어요
            </button>
          ) : (
            <>
              <div className="analysis-card-secondary-actions">
                <button
                  className="button ghost small"
                  onClick={() => setEditing(true)}
                >
                  수정
                </button>
                <button
                  className="text-button danger"
                  onClick={() => onDelete(item.id)}
                >
                  삭제
                </button>
              </div>
              <button
                className="button primary small add-to-list-button"
                onClick={() => onAdd(item)}
              >
                쇼핑 리스트에 추가
              </button>
            </>
          )}
        </div>
      </article>
      {editing && (
        <div className="modal-backdrop" onMouseDown={() => setEditing(false)}>
          <section
            className="modal edit-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <p className="section-kicker">AI ANALYSIS ITEM</p>
                <h2>분석 물품 수정</h2>
              </div>
              <button
                className="icon-button"
                aria-label="닫기"
                onClick={() => setEditing(false)}
              >
                ×
              </button>
            </div>
            <p className="modal-intro">
              일정에 맞춰 물품 정보와 권장 액션을 수정해 주세요.
            </p>
            <ItemEditor
              item={item}
              onSave={(updated) => {
                onUpdate(updated);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          </section>
        </div>
      )}
    </>
  );
}

function AnalysisSourceSection({
  title,
  description,
  tone,
  items,
  shoppingList,
  onAdd,
  onDelete,
  onUpdate,
}) {
  if (!items.length) return null;

  return (
    <section className={`suggestion-source source-panel-${tone}`}>
      <div className="suggestion-source-heading">
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        <b>{items.length}</b>
      </div>
      <div className="suggestion-grid">
        {items.map((item) => {
          const existingItem = shoppingList.find(
            (saved) =>
              normalize(saved.name) === normalize(item.name) &&
              normalize(saved.eventName) === normalize(item.eventName),
          );
          return (
            <AnalysisItemCard
              item={item}
              existingItem={existingItem}
              key={item.id}
              onAdd={onAdd}
              onDelete={onDelete}
              onUpdate={onUpdate}
            />
          );
        })}
      </div>
    </section>
  );
}

function ShoppingListReceipt({ items }) {
  return (
    <aside className="shopping-receipt" aria-label="현재 쇼핑 리스트 물품">
      <div className="receipt-heading">
        <p>SHOPPING LIST</p>
        <h3>담아둔 물품</h3>
        <small>{items.length} ITEMS</small>
      </div>
      {items.length ? (
        <ol className="receipt-items">
          {items.map((item) => (
            <li
              className={item.status === "purchased" ? "is-completed" : ""}
              key={item.id}
            >
              {item.name}
            </li>
          ))}
        </ol>
      ) : (
        <p className="receipt-empty">아직 담긴 물품이 없어요.</p>
      )}
      <div className="receipt-total">
        <span>TOTAL</span>
        <b>{items.length}</b>
      </div>
    </aside>
  );
}

function AddConfirmationModal({ itemName, onClose, onOpenShoppingList }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-confirmation-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirmation-mark">✓</div>
        <p className="section-kicker">SHOPPING LIST</p>
        <h2 id="add-confirmation-title">추가가 완료되었습니다.</h2>
        <p>
          쇼핑 리스트에서 <b>{itemName}</b> 항목을 확인할 수 있어요.
        </p>
        <div className="confirmation-actions">
          <button className="button ghost" onClick={onClose}>
            계속 보기
          </button>
          <button className="button primary" onClick={onOpenShoppingList}>
            쇼핑 리스트 보기
          </button>
        </div>
      </section>
    </div>
  );
}

function RecommendationModal({ item, onClose, onSelect }) {
  const [state, setState] = useState({
    loading: true,
    products: [],
    error: "",
  });

  useEffect(() => {
    let active = true;
    fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item }),
    })
      .then(async (response) => {
        const data = await parseApiResponse(
          response,
          "상품 추천에 실패했습니다.",
        );
        if (!response.ok)
          throw new Error(data.error || "상품 추천을 불러오지 못했습니다.");
        return data;
      })
      .then(
        (data) =>
          active &&
          setState({
            loading: false,
            products: data.recommendations || [],
            error: "",
            demoMode: data.demoMode,
          }),
      )
      .catch(
        (error) =>
          active &&
          setState({ loading: false, products: [], error: error.message }),
      );
    return () => {
      active = false;
    };
  }, [item]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">AI 상품 찾기</p>
            <h2>{item.name} 추천 결과</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <p className="modal-intro">
          일정과 AI 권장 액션 시점을 고려해 수집된 상품 중에서 골랐어요. 배송
          정보는 확인된 내용만 표시합니다.
        </p>
        {state.demoMode && (
          <div className="notice">
            OpenAI API 키가 없어 수집 결과를 기준으로 정렬한 데모 추천입니다.
          </div>
        )}
        {state.loading && (
          <div className="loading">상품 정보를 찾고 있어요...</div>
        )}
        {state.error && <div className="error-box">{state.error}</div>}
        <div className="product-list">
          {state.products.map((product, index) => (
            <article className="product-card" key={`${product.link}-${index}`}>
              <div className="product-rank">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="product-body">
                <h3>{product.productTitle}</h3>
                <div className="product-meta">
                  <strong>{product.price || "가격 확인 필요"}</strong>
                  <span>
                    {product.deliveryInfo || "배송 정보: 확인할 수 없음"}
                  </span>
                </div>
                <p>
                  <b>추천 이유</b> {product.reason}
                </p>
                <p className="caution">
                  <b>확인할 점</b> {product.caution}
                </p>
                <div className="card-actions">
                  <a
                    className="button ghost small"
                    href={product.link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    상품 보기
                  </a>
                  <button
                    className="button primary small"
                    onClick={() => onSelect(product)}
                  >
                    이 상품 선택
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProductLinkModal({ item, onClose, onSave }) {
  const [draft, setDraft] = useState({
    productTitle: item.selectedProduct?.productTitle || "",
    link: item.selectedProduct?.link || "",
  });
  const [error, setError] = useState("");

  function save() {
    const link = draft.link.trim();
    if (!/^https?:\/\/\S+$/i.test(link)) {
      setError("http:// 또는 https://로 시작하는 상품 링크를 입력해 주세요.");
      return;
    }
    onSave({
      productTitle: draft.productTitle.trim() || `${item.name} 직접 등록 상품`,
      link,
      price: "직접 확인",
      deliveryInfo: "사용자 등록 링크",
      reason: "사용자가 직접 찾은 상품 링크예요.",
      caution: "상품 페이지에서 옵션, 가격, 배송 가능일을 확인해 주세요.",
      source: "manual_link",
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal link-registration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-registration-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <p className="section-kicker">PRODUCT LINK</p>
            <h2 id="link-registration-title">상품 링크 등록</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <p className="modal-intro">
          직접 찾은 상품이 있다면 링크를 저장해 두세요. 실제 옵션과 배송
          가능일은 상품 페이지에서 확인해 주세요.
        </p>
        <div className="editor-grid">
          <Field label="상품명" wide>
            <input
              value={draft.productTitle}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  productTitle: event.target.value,
                }))
              }
              placeholder={`${item.name} 상품명 (선택)`}
            />
          </Field>
          <Field label="상품 링크" wide>
            <input
              type="url"
              value={draft.link}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  link: event.target.value,
                }))
              }
              placeholder="https://..."
            />
          </Field>
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="editor-actions">
          <button className="button primary small" onClick={save}>
            링크 저장
          </button>
          <button className="button ghost small" onClick={onClose}>
            취소
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const { route, navigate } = useRouter();
  const activeView = route.name;
  const selectedMemoId = route.memoId || null;
  const [memos, setMemos] = useStoredState("salddeut.memos", createLegacyMemos);
  const [analysesByMemoId, setAnalysesByMemoId] = useStoredState(
    "salddeut.analysesByMemoId",
    createLegacyAnalyses,
    migrateAnalyses,
  );
  const [shoppingList, setShoppingList] = useStoredState(
    "salddeut.shoppingList",
    createLegacyShoppingList,
    migrateShoppingList,
  );
  const [newMemo, setNewMemo] = useState({ title: "", content: "" });
  const [analysisState, setAnalysisState] = useState({
    loadingMemoId: null,
    error: "",
  });
  const [manualEventName, setManualEventName] = useState(null);
  const [collapsedEvents, setCollapsedEvents] = useState({});
  const [addedItemName, setAddedItemName] = useState(null);
  const [editingListItem, setEditingListItem] = useState(null);
  const [recommendationItem, setRecommendationItem] = useState(null);
  const [linkRegistrationItem, setLinkRegistrationItem] = useState(null);
  const [sortBy, setSortBy] = useState("action");

  const memoById = useMemo(
    () => Object.fromEntries(memos.map((memo) => [memo.id, memo])),
    [memos],
  );
  const selectedMemo = selectedMemoId ? memoById[selectedMemoId] : null;
  const selectedAnalysis = selectedMemoId
    ? analysesByMemoId[selectedMemoId]
    : null;
  const selectedAnalysisEventNames = selectedAnalysis
    ? [
        ...new Set([
          ...(selectedAnalysis.eventNames || []),
          ...(selectedAnalysis.items || []).map(
            (item) => item.eventName || "기타 구매",
          ),
        ]),
      ]
    : [];

  const sortedShoppingList = useMemo(() => {
    return [...shoppingList].sort((a, b) => {
      if (sortBy === "action")
        return compareDate(a.recommendedActionDate, b.recommendedActionDate);
      if (sortBy === "neededDate")
        return compareDate(a.neededDate, b.neededDate);
      if (sortBy === "recent")
        return compareCreatedAtDescending(a.addedAt, b.addedAt);
      if (a.status === "purchased" && b.status !== "purchased") return 1;
      if (b.status === "purchased" && a.status !== "purchased") return -1;
      return compareCreatedAtDescending(a.addedAt, b.addedAt);
    });
  }, [shoppingList, sortBy]);

  function openHome() {
    navigate("/");
    setAddedItemName(null);
  }

  function openInbox() {
    navigate("/memos");
    setAnalysisState((current) => ({ ...current, error: "" }));
  }

  function openShoppingList() {
    navigate("/shopping-list");
    setAddedItemName(null);
  }

  function openMemoDetail(memoId) {
    navigate(`/memos/${encodeURIComponent(memoId)}`);
  }

  function createMemoFromDraft() {
    const content = newMemo.content.trim();
    if (!content) return null;
    return {
      id: uid("memo"),
      title: newMemo.title.trim() || makeMemoTitle(content),
      content,
      createdAt: new Date().toISOString(),
    };
  }

  function saveMemo() {
    const memo = createMemoFromDraft();
    if (!memo) return;
    setMemos((current) => [memo, ...current]);
    setNewMemo({ title: "", content: "" });
  }

  function saveAndAnalyzeMemo() {
    const memo = createMemoFromDraft();
    if (!memo) return;
    setMemos((current) => [memo, ...current]);
    setNewMemo({ title: "", content: "" });
    analyzeMemo(memo);
  }

  async function analyzeMemo(memo) {
    setAnalysisState({ loadingMemoId: memo.id, error: "" });
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo: memo.content }),
      });
      const data = await parseApiResponse(
        response,
        "메모 분석에 실패했습니다.",
      );
      if (!response.ok)
        throw new Error(data.error || "메모를 분석하지 못했습니다.");

      const analysis = {
        memoId: memo.id,
        eventNames: [
          ...new Set(
            data.events.map((event) => event.eventName || "기타 구매"),
          ),
        ],
        eventMetaByName: Object.fromEntries(
          data.events.map((event) => [
            event.eventName || "기타 구매",
            createEventMeta(event),
          ]),
        ),
        items: flattenEvents(data.events),
        analyzedAt: new Date().toISOString(),
        demoMode: Boolean(data.demoMode),
      };
      setAnalysesByMemoId((current) => ({ ...current, [memo.id]: analysis }));
      navigate(`/memos/${encodeURIComponent(memo.id)}/analysis`);
    } catch (error) {
      setAnalysisState({ loadingMemoId: null, error: error.message });
      return;
    }
    setAnalysisState({ loadingMemoId: null, error: "" });
  }

  function openAnalysis(memoId) {
    setManualEventName(null);
    navigate(`/memos/${encodeURIComponent(memoId)}/analysis`);
  }

  function updateAnalysisItems(updater) {
    if (!selectedMemoId) return;
    setAnalysesByMemoId((current) => ({
      ...current,
      [selectedMemoId]: {
        ...current[selectedMemoId],
        items: updater(current[selectedMemoId]?.items || []),
      },
    }));
  }

  function updateAnalysisEventDate(eventName, value) {
    if (!selectedMemoId) return;
    const eventDate = value || null;
    const eventDateText = value
      ? `${formatDate(value)} (직접 입력)`
      : "날짜 확인 필요";
    const eventDateConfidence = value ? "high" : "low";

    setAnalysesByMemoId((current) => {
      const analysis = current[selectedMemoId];
      const eventItems = (analysis?.items || []).filter(
        (item) => item.eventName === eventName,
      );
      return {
        ...current,
        [selectedMemoId]: {
          ...analysis,
          eventMetaByName: {
            ...(analysis.eventMetaByName || {}),
            [eventName]: {
              ...getEventMeta(analysis, eventName, eventItems),
              eventDate,
              eventDateText,
              eventDateConfidence,
            },
          },
          items: (analysis.items || []).map((item) =>
            item.eventName === eventName
              ? {
                  ...item,
                  neededDate: eventDate,
                  neededDateText: eventDateText,
                  dateConfidence: eventDateConfidence,
                  recommendedActionTimingText:
                    eventDate && !item.recommendedActionDate
                      ? `${formatDate(
                          eventDate,
                        )} 기준 AI 권장 액션 시점 직접 수정 필요`
                      : item.recommendedActionTimingText,
                }
              : item,
          ),
        },
      };
    });
    setShoppingList((current) =>
      current.map((item) =>
        item.sourceMemoId === selectedMemoId && item.eventName === eventName
          ? {
              ...item,
              neededDate: eventDate,
              neededDateText: eventDateText,
              dateConfidence: eventDateConfidence,
              recommendedActionTimingText:
                eventDate && !item.recommendedActionDate
                  ? `${formatDate(
                      eventDate,
                    )} 기준 AI 권장 액션 시점 직접 수정 필요`
                  : item.recommendedActionTimingText,
            }
          : item,
      ),
    );
  }

  function addManualAnalysisItem(item) {
    if (!selectedMemoId) return;
    const manualItem = {
      ...normalizeAnalysisItem(
        {
          ...item,
          userIntent: item.userIntent || "unknown",
          userIntentText: item.userIntentText || "직접 추가한 준비 물품",
          actionReason:
            item.actionReason || "사용자가 분석 결과를 보고 직접 추가했어요.",
        },
        { eventName: item.eventName || "기타 구매" },
        "manual",
      ),
      id: uid("manual"),
      reason: item.reason || "직접 추가한 물품",
    };
    setAnalysesByMemoId((current) => {
      const analysis = current[selectedMemoId];
      return {
        ...current,
        [selectedMemoId]: {
          ...analysis,
          eventNames: [
            ...new Set([...(analysis.eventNames || []), manualItem.eventName]),
          ],
          items: [...(analysis.items || []), manualItem],
        },
      };
    });
    setManualEventName(null);
  }

  function addToShoppingList(item) {
    if (!selectedMemoId) return;
    const duplicate = shoppingList.some(
      (saved) =>
        normalize(saved.name) === normalize(item.name) &&
        normalize(saved.eventName) === normalize(item.eventName),
    );
    if (duplicate) return;
    const analysis = analysesByMemoId[selectedMemoId];
    const eventItems = (analysis?.items || []).filter(
      (analysisItem) => analysisItem.eventName === item.eventName,
    );
    const eventMeta = getEventMeta(analysis || {}, item.eventName, eventItems);

    setShoppingList((current) => [
      ...current,
      {
        ...item,
        id: uid("shopping"),
        analysisItemId: item.id,
        sourceMemoId: selectedMemoId,
        status: "pending",
        selectedProduct: null,
        purchasedAt: null,
        addedAt: new Date().toISOString(),
        neededDate: eventMeta.eventDate,
        neededDateText: eventMeta.eventDateText,
        dateConfidence: eventMeta.eventDateConfidence,
      },
    ]);
    setAddedItemName(item.name);
  }

  function toggleEvent(eventName) {
    setCollapsedEvents((current) => ({
      ...current,
      [eventName]: !current[eventName],
    }));
  }

  function updateListItem(updated) {
    setShoppingList((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    setEditingListItem(null);
  }

  function removeListItem(id) {
    setShoppingList((current) => current.filter((item) => item.id !== id));
  }

  function updateShoppingListNeededDate(id, value) {
    const neededDate = value || null;
    setShoppingList((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              neededDate,
              neededDateText: neededDate
                ? `${formatDate(neededDate)} (직접 입력)`
                : "날짜 확인 필요",
              dateConfidence: neededDate ? "high" : "low",
              recommendedActionTimingText:
                neededDate && !item.recommendedActionDate
                  ? `${formatDate(
                      neededDate,
                    )} 기준 AI 권장 액션 시점 직접 수정 필요`
                  : item.recommendedActionTimingText,
            }
          : item,
      ),
    );
  }

  function removeMemo(memo) {
    const shouldDelete = window.confirm(
      `"${memo.title}" 메모를 삭제할까요?\n\n연결된 AI 분석 결과도 함께 삭제됩니다. 이미 쇼핑 리스트에 담은 물품은 유지됩니다.`,
    );
    if (!shouldDelete) return false;

    setMemos((current) => current.filter((saved) => saved.id !== memo.id));
    setAnalysesByMemoId((current) => {
      const next = { ...current };
      delete next[memo.id];
      return next;
    });
    return true;
  }

  function togglePurchased(id) {
    setShoppingList((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: item.status === "purchased" ? "pending" : "purchased",
              purchasedAt:
                item.status === "purchased" ? null : new Date().toISOString(),
            }
          : item,
      ),
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" onClick={openHome}>
            <span className="brand-copy">
              <b>살뜰</b>
              <small>우리 가족 생활용품 비서</small>
            </span>
          </button>
          <nav className="main-nav" aria-label="주요 화면">
            <button
              className={
                activeView === "inbox" ||
                activeView === "memoDetail" ||
                activeView === "analysis"
                  ? "active"
                  : ""
              }
              onClick={openInbox}
            >
              <span>메모함</span>
              <b>{memos.length}</b>
            </button>
            <button
              className={activeView === "shopping" ? "active" : ""}
              onClick={openShoppingList}
            >
              <span>쇼핑 리스트</span>
              <b>{shoppingList.length}</b>
            </button>
          </nav>
        </div>
      </header>

      <main>
        {activeView === "home" && (
          <section className="hero onboarding-hero">
            <div className="onboarding-content">
              <p className="eyebrow">FAMILY PURCHASE AGENT</p>
              <h1>
                놓치기 쉬운 살 것들을
                <br />
                AI가 먼저 챙겨드려요.
              </h1>
              <p>
                우리 가족의 생활용품과 관련된 메모를 적으면, 필요한 물건과 사야
                할 때를 AI가 정리해드려요.
              </p>
              <button
                className="button primary onboarding-cta"
                onClick={openInbox}
              >
                지금 시작하기 <span>→</span>
              </button>
            </div>
            <div className="onboarding-points" aria-label="주요 기능">
              <span>여러 메모를 한곳에</span>
              <span>AI가 준비물을 정리</span>
              <span>필요할 때 상품 추천</span>
            </div>
          </section>
        )}

        {activeView === "inbox" && (
          <section className="panel inbox-panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">MEMO INBOX</p>
                <h2>메모함</h2>
                <p>
                  가족 일정에서 생기는 준비물을 메모로 남겨 두세요. 필요한
                  메모만 골라 AI로 분석할 수 있어요.
                </p>
              </div>
            </div>
            <section className="new-memo-card">
              <div className="new-memo-heading">
                <div>
                  <p className="section-kicker">NEW MEMO</p>
                  <h3>새 메모 작성</h3>
                </div>
                <span>저장 후 원하는 시점에 AI로 분석해요.</span>
              </div>
              <input
                className="memo-title-input"
                value={newMemo.title}
                onChange={(event) =>
                  setNewMemo((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="메모 제목 (선택)"
              />
              <textarea
                value={newMemo.content}
                onChange={(event) =>
                  setNewMemo((current) => ({
                    ...current,
                    content: event.target.value,
                  }))
                }
                placeholder="예: 다음 주 금요일 지우 유치원 소풍. 도시락통 새로 사야 하고 물통도 확인해야 함. 다음 달 초에는 엄마 생신 선물도 봐야 함."
              />
              <div className="new-memo-actions">
                <button
                  className="button ghost"
                  onClick={saveMemo}
                  disabled={!newMemo.content.trim()}
                >
                  메모 저장
                </button>
                <button
                  className="button primary"
                  onClick={saveAndAnalyzeMemo}
                  disabled={
                    !newMemo.content.trim() ||
                    Boolean(analysisState.loadingMemoId)
                  }
                >
                  {analysisState.loadingMemoId
                    ? "AI가 분석하고 있어요..."
                    : "AI 분석하기"}
                </button>
              </div>
            </section>
            {analysisState.error && (
              <div className="error-box">{analysisState.error}</div>
            )}
            {memos.length === 0 ? (
              <EmptyState
                title="아직 저장한 메모가 없어요."
                description="위에서 첫 메모를 작성해 보세요. 저장만으로는 AI 분석이 실행되지 않아요."
              />
            ) : (
              <div className="memo-card-grid">
                {memos.map((memo) => (
                  <MemoCard
                    memo={memo}
                    analysis={analysesByMemoId[memo.id]}
                    addedItems={shoppingList.filter(
                      (item) => item.sourceMemoId === memo.id,
                    )}
                    isLoading={analysisState.loadingMemoId === memo.id}
                    key={memo.id}
                    onOpenDetail={() => openMemoDetail(memo.id)}
                    onAnalyze={() => analyzeMemo(memo)}
                    onOpenAnalysis={() => openAnalysis(memo.id)}
                    onDelete={() => removeMemo(memo)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {activeView === "memoDetail" && selectedMemo && (
          <section className="panel memo-detail-panel">
            <div className="workspace-toolbar">
              <button className="back-button" onClick={openInbox}>
                ← 메모함으로 돌아가기
              </button>
              <button className="button ghost" onClick={openShoppingList}>
                쇼핑 리스트 보기
              </button>
            </div>
            <article className="memo-detail-card">
              <div className="memo-detail-heading">
                <div>
                  <p className="section-kicker">MEMO DETAIL</p>
                  <h2>{selectedMemo.title}</h2>
                </div>
                <div className="memo-detail-meta">
                  <Badge tone={selectedAnalysis ? "sage" : "apricot"}>
                    {selectedAnalysis ? "분석 완료" : "분석 전"}
                  </Badge>
                  <time>{formatCreatedAt(selectedMemo.createdAt)}</time>
                </div>
              </div>
              <div className="memo-detail-content">{selectedMemo.content}</div>
              <div className="memo-detail-actions">
                {selectedAnalysis ? (
                  <>
                    <button
                      className="button primary"
                      onClick={() => openAnalysis(selectedMemo.id)}
                    >
                      분석 결과 보기
                    </button>
                    <button
                      className="button ghost"
                      onClick={() => analyzeMemo(selectedMemo)}
                      disabled={analysisState.loadingMemoId === selectedMemo.id}
                    >
                      {analysisState.loadingMemoId === selectedMemo.id
                        ? "분석 중..."
                        : "다시 분석"}
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary"
                    onClick={() => analyzeMemo(selectedMemo)}
                    disabled={analysisState.loadingMemoId === selectedMemo.id}
                  >
                    {analysisState.loadingMemoId === selectedMemo.id
                      ? "AI가 분석하고 있어요..."
                      : "AI로 분석하기"}
                  </button>
                )}
                <button
                  className="text-button danger memo-detail-delete-button"
                  onClick={() => {
                    if (removeMemo(selectedMemo)) openInbox();
                  }}
                  disabled={analysisState.loadingMemoId === selectedMemo.id}
                >
                  메모 삭제
                </button>
              </div>
            </article>
            {analysisState.error && (
              <div className="error-box">{analysisState.error}</div>
            )}
            {selectedAnalysis && (
              <section className="memo-detail-items">
                <div className="memo-detail-section-heading">
                  <div>
                    <p className="section-kicker">SHOPPING LIST ITEMS</p>
                    <h3>이 메모에서 추가한 물품</h3>
                  </div>
                  <b>
                    {
                      shoppingList.filter(
                        (item) => item.sourceMemoId === selectedMemo.id,
                      ).length
                    }
                  </b>
                </div>
                {shoppingList.filter(
                  (item) => item.sourceMemoId === selectedMemo.id,
                ).length > 0 ? (
                  <div className="memo-detail-item-list">
                    {shoppingList
                      .filter((item) => item.sourceMemoId === selectedMemo.id)
                      .map((item) => (
                        <div className="memo-detail-item" key={item.id}>
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.eventName || "관련 일정 없음"}</small>
                          </span>
                          <Badge
                            tone={
                              item.status === "purchased" ? "sage" : "neutral"
                            }
                          >
                            {item.status === "purchased"
                              ? "구매 완료"
                              : "구매 전"}
                          </Badge>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="memo-detail-empty">
                    아직 이 메모에서 쇼핑 리스트로 추가한 물품이 없어요.
                  </p>
                )}
              </section>
            )}
          </section>
        )}

        {activeView === "memoDetail" && !selectedMemo && (
          <section className="panel">
            <EmptyState
              title="메모를 찾을 수 없어요."
              description="메모함에서 확인할 메모를 다시 선택해 주세요."
              action={
                <button className="button primary" onClick={openInbox}>
                  메모함으로 이동
                </button>
              }
            />
          </section>
        )}

        {activeView === "analysis" && selectedMemo && selectedAnalysis && (
          <section className="panel analysis-panel">
            <div className="workspace-toolbar">
              <button className="back-button" onClick={openInbox}>
                ← 메모함으로 돌아가기
              </button>
              <button className="button primary" onClick={openShoppingList}>
                쇼핑 리스트 보기
              </button>
            </div>
            <div className="analysis-layout">
              <div className="analysis-main">
                <section className="analysis-summary">
                  <div>
                    <p className="section-kicker">AI ANALYSIS WORKSPACE</p>
                    <h2>{selectedMemo.title}</h2>
                    <p>{selectedMemo.content}</p>
                  </div>
                  <div className="analysis-meta">
                    <Badge tone="sage">분석 완료</Badge>
                    <small>
                      {formatCreatedAt(selectedAnalysis.analyzedAt)}
                    </small>
                  </div>
                </section>
                {selectedAnalysis.demoMode && (
                  <div className="notice">
                    OpenAI API 키가 없어 예시 분석을 보여 드리고 있어요. 키를
                    연결하면 작성한 메모를 AI가 직접 분석합니다.
                  </div>
                )}
                <div className="suggestion-groups">
                  {selectedAnalysisEventNames.map((eventName) => {
                    const eventItems = selectedAnalysis.items.filter(
                      (item) => item.eventName === eventName,
                    );
                    const eventMeta = getEventMeta(
                      selectedAnalysis,
                      eventName,
                      eventItems,
                    );
                    const eventDateNeedsInput =
                      !eventMeta.eventDate ||
                      eventMeta.eventDateConfidence === "low";
                    return (
                      <section className="event-group" key={eventName}>
                        <button
                          className="event-title"
                          onClick={() => toggleEvent(eventName)}
                          aria-expanded={!collapsedEvents[eventName]}
                        >
                          <span>일정</span>
                          <h3>{eventName}</h3>
                          <b>{eventItems.length}</b>
                          <i
                            className={`event-chevron ${
                              collapsedEvents[eventName] ? "collapsed" : ""
                            }`}
                          >
                            ⌃
                          </i>
                        </button>
                        <div className="event-date-bar">
                          <div>
                            <span>공통 필요 날짜</span>
                            <strong>{formatEventDate(eventMeta)}</strong>
                          </div>
                          {eventDateNeedsInput && (
                            <label>
                              <span>날짜 입력 필요</span>
                              <input
                                aria-label={`${eventName} 필요 날짜 입력`}
                                type="date"
                                value={toInputDate(eventMeta.eventDate)}
                                onChange={(event) =>
                                  updateAnalysisEventDate(
                                    eventName,
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                          )}
                        </div>
                        {!collapsedEvents[eventName] && (
                          <div className="event-content">
                            <AnalysisSourceSection
                              title="사용자 언급 물품"
                              description="메모에서 직접 찾은 물품이에요."
                              tone="mentioned"
                              items={eventItems.filter(
                                (item) => item.sourceType === "mentioned",
                              )}
                              shoppingList={shoppingList}
                              onAdd={addToShoppingList}
                              onDelete={(id) =>
                                updateAnalysisItems((items) =>
                                  items.filter((item) => item.id !== id),
                                )
                              }
                              onUpdate={(updated) =>
                                updateAnalysisItems((items) =>
                                  items.map((item) =>
                                    item.id === updated.id ? updated : item,
                                  ),
                                )
                              }
                            />
                            <AnalysisSourceSection
                              title="AI 추가 추천 물품"
                              description="일정 맥락을 바탕으로 함께 챙겨 본 물품이에요."
                              tone="suggested"
                              items={eventItems.filter(
                                (item) => item.sourceType === "suggested",
                              )}
                              shoppingList={shoppingList}
                              onAdd={addToShoppingList}
                              onDelete={(id) =>
                                updateAnalysisItems((items) =>
                                  items.filter((item) => item.id !== id),
                                )
                              }
                              onUpdate={(updated) =>
                                updateAnalysisItems((items) =>
                                  items.map((item) =>
                                    item.id === updated.id ? updated : item,
                                  ),
                                )
                              }
                            />
                            <AnalysisSourceSection
                              title="직접 추가한 물품"
                              description="분석 결과를 보고 직접 보완한 물품이에요."
                              tone="manual"
                              items={eventItems.filter(
                                (item) => item.sourceType === "manual",
                              )}
                              shoppingList={shoppingList}
                              onAdd={addToShoppingList}
                              onDelete={(id) =>
                                updateAnalysisItems((items) =>
                                  items.filter((item) => item.id !== id),
                                )
                              }
                              onUpdate={(updated) =>
                                updateAnalysisItems((items) =>
                                  items.map((item) =>
                                    item.id === updated.id ? updated : item,
                                  ),
                                )
                              }
                            />
                            {manualEventName === eventName ? (
                              <ItemEditor
                                item={{
                                  name: "",
                                  eventName,
                                  neededDate: eventMeta.eventDate,
                                  neededDateText: eventMeta.eventDateText,
                                  dateConfidence: eventMeta.eventDateConfidence,
                                  recommendedActionDate: null,
                                  recommendedActionEndDate: null,
                                  recommendedActionTimingText: "",
                                  recommendedActionType: "date_needed",
                                  actionReason: "",
                                  note: "",
                                }}
                                onSave={addManualAnalysisItem}
                                onCancel={() => setManualEventName(null)}
                              />
                            ) : (
                              <button
                                className="manual-add-card"
                                onClick={() => setManualEventName(eventName)}
                              >
                                <span>+</span>
                                <strong>직접 추가</strong>
                                <small>
                                  이 일정에서 빠진 물품을 추가해 주세요.
                                </small>
                              </button>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </div>
              <ShoppingListReceipt items={shoppingList} />
            </div>
          </section>
        )}

        {activeView === "analysis" && (!selectedMemo || !selectedAnalysis) && (
          <section className="panel">
            <EmptyState
              title="분석 결과를 찾을 수 없어요."
              description="메모함에서 분석할 메모를 선택해 주세요."
              action={
                <button className="button primary" onClick={openInbox}>
                  메모함으로 이동
                </button>
              }
            />
          </section>
        )}

        {activeView === "shopping" && (
          <section className="panel shopping-panel">
            <div className="section-heading list-heading">
              <div>
                <p className="section-kicker">PERMANENT SHOPPING LIST</p>
                <h2>쇼핑 리스트</h2>
                <p>
                  여러 메모에서 확정한 물품을 한곳에 모았어요. 상품 찾기와 구매
                  완료 처리도 여기에서 진행해 주세요.
                </p>
              </div>
              <label className="sort-control">
                <span>정렬</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value)}
                >
                  <option value="action">AI 권장 액션 시점순</option>
                  <option value="neededDate">필요 날짜순</option>
                  <option value="recent">최근 추가순</option>
                  <option value="status">구매 전/완료순</option>
                </select>
              </label>
            </div>
            {shoppingList.length === 0 ? (
              <EmptyState
                title="쇼핑 리스트가 비어 있어요."
                description="메모함에서 필요한 메모를 분석하고 물품을 추가해 주세요."
                action={
                  <button className="button primary" onClick={openInbox}>
                    메모함 보러 가기
                  </button>
                }
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>물품</th>
                      <th>관련 일정</th>
                      <th>출처 메모</th>
                      <th>필요 날짜</th>
                      <th>AI 권장 액션 시점</th>
                      <th>권장 이유</th>
                      <th>비고</th>
                      <th>구매할 상품</th>
                      <th>상태</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedShoppingList.map((item) => (
                      <tr
                        key={item.id}
                        className={
                          item.status === "purchased" ? "completed-row" : ""
                        }
                      >
                        <td>
                          <b>{item.name}</b>
                          <small>{sourceLabels[item.sourceType]}</small>
                        </td>
                        <td>{item.eventName || "-"}</td>
                        <td className="source-memo-cell">
                          {memoById[item.sourceMemoId] ? (
                            <button
                              className="text-button source-memo-link"
                              onClick={() => openMemoDetail(item.sourceMemoId)}
                            >
                              {memoById[item.sourceMemoId].title}
                            </button>
                          ) : (
                            "이전 메모"
                          )}
                        </td>
                        <td>
                          <span>{formatNeededDate(item)}</span>
                          {(!item.neededDate ||
                            item.dateConfidence === "low") && (
                            <label className="table-date-input">
                              <b>날짜 입력 필요</b>
                              <input
                                aria-label={`${item.name} 필요 날짜 입력`}
                                type="date"
                                value={toInputDate(item.neededDate)}
                                onChange={(event) =>
                                  updateShoppingListNeededDate(
                                    item.id,
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                          )}
                        </td>
                        <td>
                          {getRecommendedActionTiming(item)}
                          {!item.recommendedActionDate && (
                            <small>
                              필요 날짜를 입력하면 AI 권장 액션 시점을 더 정확히
                              정리할 수 있어요.
                            </small>
                          )}
                        </td>
                        <td>{item.actionReason || item.reason || "-"}</td>
                        <td>{item.note || "-"}</td>
                        <td className="product-cell">
                          {item.selectedProduct ? (
                            <>
                              <b>{item.selectedProduct.productTitle}</b>
                              <a
                                href={item.selectedProduct.link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                링크 열기
                              </a>
                              <button
                                className="text-button"
                                onClick={() => setRecommendationItem(item)}
                              >
                                AI로 다시 찾기
                              </button>
                              <button
                                className="text-button"
                                onClick={() => setLinkRegistrationItem(item)}
                              >
                                링크 변경
                              </button>
                            </>
                          ) : (
                            <div className="product-actions">
                              <button
                                className="button ghost mini"
                                onClick={() => setLinkRegistrationItem(item)}
                              >
                                상품 링크 등록
                              </button>
                              <button
                                className="button mini"
                                onClick={() => setRecommendationItem(item)}
                              >
                                AI로 상품 찾기
                              </button>
                            </div>
                          )}
                        </td>
                        <td>
                          <button
                            className={`status-button ${item.status}`}
                            onClick={() => togglePurchased(item.id)}
                          >
                            {item.status === "purchased"
                              ? "구매 완료"
                              : "구매 전"}
                          </button>
                          {item.purchasedAt && (
                            <small>{formatCreatedAt(item.purchasedAt)}</small>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="text-button"
                              onClick={() => setEditingListItem(item)}
                            >
                              수정
                            </button>
                            <button
                              className="text-button danger"
                              onClick={() => removeListItem(item.id)}
                            >
                              삭제
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {activeView === "notFound" && (
          <section className="panel">
            <EmptyState
              title="페이지를 찾을 수 없어요."
              description="주소를 다시 확인하거나 홈으로 돌아가 주세요."
              action={
                <button className="button primary" onClick={openHome}>
                  홈으로 이동
                </button>
              }
            />
          </section>
        )}
      </main>

      <footer>
        살뜰 <span>·</span> 가족의 살 것을 기억 대신 실행으로
      </footer>

      {addedItemName && (
        <AddConfirmationModal
          itemName={addedItemName}
          onClose={() => setAddedItemName(null)}
          onOpenShoppingList={openShoppingList}
        />
      )}
      {editingListItem && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setEditingListItem(null)}
        >
          <section
            className="modal edit-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>쇼핑 리스트 항목 수정</h2>
              <button
                className="icon-button"
                onClick={() => setEditingListItem(null)}
              >
                ×
              </button>
            </div>
            <ItemEditor
              item={editingListItem}
              onSave={updateListItem}
              onCancel={() => setEditingListItem(null)}
            />
          </section>
        </div>
      )}
      {recommendationItem && (
        <RecommendationModal
          item={recommendationItem}
          onClose={() => setRecommendationItem(null)}
          onSelect={(product) => {
            setShoppingList((current) =>
              current.map((item) =>
                item.id === recommendationItem.id
                  ? { ...item, selectedProduct: product }
                  : item,
              ),
            );
            setRecommendationItem(null);
          }}
        />
      )}
      {linkRegistrationItem && (
        <ProductLinkModal
          item={linkRegistrationItem}
          onClose={() => setLinkRegistrationItem(null)}
          onSave={(product) => {
            setShoppingList((current) =>
              current.map((item) =>
                item.id === linkRegistrationItem.id
                  ? { ...item, selectedProduct: product }
                  : item,
              ),
            );
            setLinkRegistrationItem(null);
          }}
        />
      )}
    </div>
  );
}

function compareDate(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return new Date(`${left}T00:00:00`) - new Date(`${right}T00:00:00`);
}

function compareCreatedAtDescending(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return new Date(right) - new Date(left);
}

export default App;
