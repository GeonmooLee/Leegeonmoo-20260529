import { useEffect, useMemo, useState } from "react";

const DEFAULT_MEMO =
  "다음 주 금요일에 지우 유치원 소풍. 도시락통 새로 사야 하고 물통도 괜찮은지 모르겠고, 돗자리는 집에 있는지 확인해 봐야 함. 다음 달 초에는 엄마 생신 선물도 봐야 함. 남편 와이셔츠도 계속 미뤘네.";

const tabs = [
  ["memo", "메모", "01"],
  ["suggestions", "AI 제안", "02"],
  ["list", "구매 리스트", "03"],
  ["today", "오늘의 구매", "04"],
];

const priorityRank = { 높음: 0, 중간: 1, 낮음: 2 };
const sourceLabels = {
  mentioned: "사용자 언급 물품",
  suggested: "AI 추가 추천 물품",
  manual: "직접 추가",
};

function uid(prefix = "item") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function useStoredState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function formatDate(value) {
  if (!value) return "날짜 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00`));
}

function dateDiff(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(`${value}T00:00:00`) - today) / 86400000);
}

function toInputDate(value) {
  return value || "";
}

function flattenEvents(events = []) {
  return events.flatMap((event) => {
    const mentioned = (event.mentionedItems || []).map((item) => ({
      ...item,
      id: item.id || uid("mention"),
      eventName: item.eventName || event.eventName,
      sourceType: "mentioned",
    }));
    const suggested = (event.suggestedItems || []).map((item) => ({
      ...item,
      id: item.id || uid("suggestion"),
      eventName: item.eventName || event.eventName,
      sourceType: "suggested",
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

function ItemEditor({ item, onSave, onCancel, compact = false }) {
  const [draft, setDraft] = useState(item);
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className={`editor ${compact ? "compact" : ""}`}>
      <div className="editor-grid">
        <Field label="물품명">
          <input value={draft.name || ""} onChange={(e) => update("name", e.target.value)} />
        </Field>
        <Field label="관련 일정">
          <input value={draft.eventName || ""} onChange={(e) => update("eventName", e.target.value)} />
        </Field>
        <Field label="필요 날짜">
          <input type="date" value={toInputDate(draft.neededDate)} onChange={(e) => update("neededDate", e.target.value || null)} />
        </Field>
        <Field label="구매 마감일">
          <input type="date" value={toInputDate(draft.purchaseDeadline)} onChange={(e) => update("purchaseDeadline", e.target.value || null)} />
        </Field>
        <Field label="우선순위">
          <select value={draft.priority || "중간"} onChange={(e) => update("priority", e.target.value)}>
            <option>높음</option>
            <option>중간</option>
            <option>낮음</option>
          </select>
        </Field>
        <Field label="비고" wide>
          <input value={draft.note || ""} onChange={(e) => update("note", e.target.value)} placeholder="선호, 사이즈, 확인할 점" />
        </Field>
      </div>
      <div className="editor-actions">
        <button className="button primary small" onClick={() => onSave(draft)} disabled={!draft.name?.trim()}>
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

function SuggestionCard({ item, onAdd, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const isSuggested = item.sourceType === "suggested";

  if (editing) {
    return (
      <ItemEditor
        item={item}
        onSave={(updated) => {
          onUpdate(updated);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <article className="suggestion-card">
      <div className="card-heading">
        <div>
          <Badge tone={isSuggested ? "sage" : "apricot"}>{sourceLabels[item.sourceType]}</Badge>
          <h4>{item.name}</h4>
        </div>
        <Badge tone={item.priority === "높음" ? "red" : "neutral"}>{item.priority || "중간"}</Badge>
      </div>
      <p className="reason">{item.reason || "필요 여부를 확인해 주세요."}</p>
      <dl className="mini-details">
        <div><dt>필요</dt><dd>{item.neededDateText || formatDate(item.neededDate)}</dd></div>
        <div><dt>구매 마감</dt><dd>{item.purchaseDeadlineText || formatDate(item.purchaseDeadline)}</dd></div>
        {item.note && <div><dt>비고</dt><dd>{item.note}</dd></div>}
      </dl>
      <div className="card-actions">
        <button className="button primary small" onClick={() => onAdd(item)}>구매 리스트에 추가</button>
        <button className="button ghost small" onClick={() => setEditing(true)}>수정</button>
        <button className="text-button danger" onClick={() => onDelete(item.id)}>삭제</button>
      </div>
    </article>
  );
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

function RecommendationModal({ item, onClose, onSelect }) {
  const [state, setState] = useState({ loading: true, products: [], error: "" });

  useEffect(() => {
    let active = true;
    fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "상품 추천을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => active && setState({ loading: false, products: data.recommendations || [], error: "", demoMode: data.demoMode }))
      .catch((error) => active && setState({ loading: false, products: [], error: error.message }));
    return () => {
      active = false;
    };
  }, [item]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">AI 상품 찾기</p>
            <h2>{item.name} 추천 결과</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>
        </div>
        <p className="modal-intro">일정과 마감일을 고려해 수집된 상품 중에서 골랐어요. 배송 정보는 확인된 내용만 표시합니다.</p>
        {state.demoMode && <div className="notice">OpenAI API 키가 없어 수집 결과를 기준으로 정렬한 데모 추천입니다.</div>}
        {state.loading && <div className="loading">상품 정보를 찾고 있어요<span>.</span><span>.</span><span>.</span></div>}
        {state.error && <div className="error-box">{state.error}</div>}
        <div className="product-list">
          {state.products.map((product, index) => (
            <article className="product-card" key={`${product.link}-${index}`}>
              <div className="product-rank">{String(index + 1).padStart(2, "0")}</div>
              <div className="product-body">
                <h3>{product.productTitle}</h3>
                <div className="product-meta">
                  <strong>{product.price || "가격 확인 필요"}</strong>
                  <span>{product.deliveryInfo || "배송 정보: 확인할 수 없음"}</span>
                </div>
                <p><b>추천 이유</b> {product.reason}</p>
                <p className="caution"><b>확인할 점</b> {product.caution}</p>
                <div className="card-actions">
                  <a className="button ghost small" href={product.link} target="_blank" rel="noreferrer">상품 보기</a>
                  <button className="button primary small" onClick={() => onSelect(product)}>이 상품 선택</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("memo");
  const [memo, setMemo] = useStoredState("salddeut.memo", DEFAULT_MEMO);
  const [suggestions, setSuggestions] = useStoredState("salddeut.suggestions", []);
  const [purchaseList, setPurchaseList] = useStoredState("salddeut.purchaseList", []);
  const [analysisMeta, setAnalysisMeta] = useStoredState("salddeut.analysisMeta", null);
  const [analysisState, setAnalysisState] = useState({ loading: false, error: "" });
  const [manualMode, setManualMode] = useState(false);
  const [editingListItem, setEditingListItem] = useState(null);
  const [recommendationItem, setRecommendationItem] = useState(null);
  const [sortBy, setSortBy] = useState("priority");

  const counts = {
    suggestions: suggestions.length,
    list: purchaseList.filter((item) => item.status !== "purchased").length,
    today: purchaseList.filter((item) => item.status !== "purchased" && dateDiff(item.purchaseDeadline) <= 0).length,
  };

  const sortedPurchaseList = useMemo(() => {
    return [...purchaseList].sort((a, b) => {
      if (a.status === "purchased" && b.status !== "purchased") return 1;
      if (b.status === "purchased" && a.status !== "purchased") return -1;
      if (sortBy === "deadline") return dateDiff(a.purchaseDeadline) - dateDiff(b.purchaseDeadline);
      if (sortBy === "neededDate") return dateDiff(a.neededDate) - dateDiff(b.neededDate);
      return (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    });
  }, [purchaseList, sortBy]);

  const todayGroups = useMemo(() => {
    const open = purchaseList.filter((item) => item.status !== "purchased");
    return [
      {
        title: "오늘 꼭 사야 해요",
        description: "마감이 오늘이거나 이미 지난 항목이에요.",
        items: open.filter((item) => dateDiff(item.purchaseDeadline) <= 0),
      },
      {
        title: "곧 사야 해요",
        description: "마감까지 3일 이내로 남았어요.",
        items: open.filter((item) => dateDiff(item.purchaseDeadline) > 0 && dateDiff(item.purchaseDeadline) <= 3),
      },
      {
        title: "아직 여유 있어요",
        description: "미리 살펴보면 마음이 가벼워질 항목이에요.",
        items: open.filter((item) => dateDiff(item.purchaseDeadline) > 3 || !item.purchaseDeadline),
      },
      {
        title: "구매 완료",
        description: "잘 챙겼어요. 완료한 기록은 여기 모아 둘게요.",
        items: purchaseList.filter((item) => item.status === "purchased"),
      },
    ];
  }, [purchaseList]);

  async function analyzeMemo() {
    if (!memo.trim()) return;
    setAnalysisState({ loading: true, error: "" });
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "메모를 분석하지 못했습니다.");
      setSuggestions(flattenEvents(data.events));
      setAnalysisMeta({ demoMode: data.demoMode, createdAt: new Date().toISOString() });
      setActiveTab("suggestions");
    } catch (error) {
      setAnalysisState({ loading: false, error: error.message });
      return;
    }
    setAnalysisState({ loading: false, error: "" });
  }

  function addToPurchaseList(item) {
    if (purchaseList.some((saved) => saved.suggestionId === item.id)) return;
    setPurchaseList((current) => [
      ...current,
      {
        ...item,
        id: uid("buy"),
        suggestionId: item.id,
        status: "pending",
        selectedProduct: null,
        purchasedAt: null,
      },
    ]);
  }

  function addManualItem(item) {
    const suggestion = { ...item, id: uid("manual"), sourceType: "manual", reason: item.reason || "직접 추가한 물품" };
    setSuggestions((current) => [...current, suggestion]);
    setManualMode(false);
  }

  function updateListItem(updated) {
    setPurchaseList((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setEditingListItem(null);
  }

  function removeListItem(id) {
    setPurchaseList((current) => current.filter((item) => item.id !== id));
  }

  function togglePurchased(id) {
    setPurchaseList((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              status: item.status === "purchased" ? "pending" : "purchased",
              purchasedAt: item.status === "purchased" ? null : new Date().toISOString(),
            }
          : item,
      ),
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <button className="brand" onClick={() => setActiveTab("memo")}>
          <span className="brand-mark">ㅅ</span>
          <span><b>살뜰</b><small>AI shopping helper</small></span>
        </button>
        <div className="header-note"><span></span>오늘의 가족 장보기를 가볍게</div>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">HOUSEHOLD SHOPPING AGENT</p>
          <h1>기억할 장보기는<br /><em>살뜰</em>하게 맡겨 주세요.</h1>
          <p>뒤섞인 가족 메모를 적으면, 필요한 물품과 살 때를 AI가 먼저 정리해 드려요.</p>
        </section>

        <nav className="tabs" aria-label="주요 화면">
          {tabs.map(([id, label, number]) => (
            <button className={`tab ${activeTab === id ? "active" : ""}`} onClick={() => setActiveTab(id)} key={id}>
              <span>{number}</span>
              {label}
              {counts[id] > 0 && <b>{counts[id]}</b>}
            </button>
          ))}
        </nav>

        {activeTab === "memo" && (
          <section className="panel memo-layout">
            <div>
              <p className="section-kicker">STEP 01</p>
              <h2>생각나는 대로<br />편하게 적어 보세요.</h2>
              <p className="section-copy">일정, 준비물, 미뤄 둔 쇼핑을 한꺼번에 적어도 괜찮아요. 필요한 장보기만 골라 정리할게요.</p>
              <div className="memo-tip"><b>이렇게 적어 보세요</b><br />“다음 주 소풍 준비물이랑 엄마 생신 선물 알아봐야 해.”</div>
            </div>
            <div className="memo-card">
              <div className="memo-label"><span></span>우리 집 메모</div>
              <textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="가족 일정과 필요한 물품을 자유롭게 적어 주세요." />
              {analysisState.error && <div className="error-box">{analysisState.error}</div>}
              <button className="button primary wide-button" onClick={analyzeMemo} disabled={analysisState.loading || !memo.trim()}>
                {analysisState.loading ? "AI가 장보기를 정리하고 있어요..." : "AI가 구매 리스트 만들기"}
                {!analysisState.loading && <span>→</span>}
              </button>
            </div>
          </section>
        )}

        {activeTab === "suggestions" && (
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">STEP 02</p>
                <h2>AI가 먼저 챙겨 봤어요.</h2>
                <p>필요한 항목만 골라 구매 리스트에 담아 주세요. 집에 있는지는 사용자가 판단할 수 있도록 직접 언급과 추가 추천을 나눴어요.</p>
              </div>
              <button className="button ghost" onClick={() => setManualMode(true)}>+ 빠진 물품 직접 추가</button>
            </div>
            {analysisMeta?.demoMode && <div className="notice">OpenAI API 키가 없어 예시 분석을 보여 드리고 있어요. 키를 연결하면 작성한 메모를 AI가 직접 분석합니다.</div>}
            {manualMode && (
              <ItemEditor
                item={{ name: "", eventName: "", neededDate: null, purchaseDeadline: null, priority: "중간", note: "" }}
                onSave={addManualItem}
                onCancel={() => setManualMode(false)}
              />
            )}
            {suggestions.length === 0 ? (
              <EmptyState
                title="아직 정리한 메모가 없어요."
                description="메모를 남기면 일정별 구매 후보를 정리해 드릴게요."
                action={<button className="button primary" onClick={() => setActiveTab("memo")}>메모 작성하기</button>}
              />
            ) : (
              <div className="suggestion-groups">
                {[...new Set(suggestions.map((item) => item.eventName || "기타 장보기"))].map((eventName) => (
                  <section className="event-group" key={eventName}>
                    <div className="event-title">
                      <span>일정</span>
                      <h3>{eventName}</h3>
                      <b>{suggestions.filter((item) => item.eventName === eventName).length}</b>
                    </div>
                    <div className="suggestion-grid">
                      {suggestions.filter((item) => item.eventName === eventName).map((item) => (
                        <SuggestionCard
                          item={item}
                          key={item.id}
                          onAdd={addToPurchaseList}
                          onDelete={(id) => setSuggestions((current) => current.filter((saved) => saved.id !== id))}
                          onUpdate={(updated) => setSuggestions((current) => current.map((saved) => (saved.id === updated.id ? updated : saved)))}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "list" && (
          <section className="panel">
            <div className="section-heading list-heading">
              <div>
                <p className="section-kicker">STEP 03</p>
                <h2>구매 리스트</h2>
                <p>확정한 장보기만 모았어요. 상품이 정해지지 않은 항목은 AI에게 찾아 달라고 해 보세요.</p>
              </div>
              <label className="sort-control">
                <span>정렬</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="priority">우선순위순</option>
                  <option value="deadline">구매 마감일순</option>
                  <option value="neededDate">필요 날짜순</option>
                </select>
              </label>
            </div>
            {purchaseList.length === 0 ? (
              <EmptyState
                title="구매 리스트가 비어 있어요."
                description="AI 제안에서 필요한 물품을 골라 담아 주세요."
                action={<button className="button primary" onClick={() => setActiveTab("suggestions")}>AI 제안 보러 가기</button>}
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>물품</th><th>관련 일정</th><th>필요 날짜</th><th>구매 마감일</th><th>우선순위</th><th>비고</th><th>구매할 상품</th><th>상태</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPurchaseList.map((item) => (
                      <tr key={item.id} className={item.status === "purchased" ? "completed-row" : ""}>
                        <td><b>{item.name}</b><small>{sourceLabels[item.sourceType]}</small></td>
                        <td>{item.eventName || "-"}</td>
                        <td>{formatDate(item.neededDate)}</td>
                        <td>{formatDate(item.purchaseDeadline)}</td>
                        <td><Badge tone={item.priority === "높음" ? "red" : "neutral"}>{item.priority || "중간"}</Badge></td>
                        <td>{item.note || "-"}</td>
                        <td className="product-cell">
                          {item.selectedProduct ? (
                            <>
                              <a href={item.selectedProduct.link} target="_blank" rel="noreferrer">{item.selectedProduct.productTitle}</a>
                              <button className="text-button" onClick={() => setRecommendationItem(item)}>다시 찾기</button>
                            </>
                          ) : (
                            <button className="button mini" onClick={() => setRecommendationItem(item)}>AI로 상품 찾기</button>
                          )}
                        </td>
                        <td>
                          <button className={`status-button ${item.status}`} onClick={() => togglePurchased(item.id)}>
                            {item.status === "purchased" ? "구매 완료" : "구매 전"}
                          </button>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="text-button" onClick={() => setEditingListItem(item)}>수정</button>
                            <button className="text-button danger" onClick={() => removeListItem(item.id)}>삭제</button>
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

        {activeTab === "today" && (
          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">TODAY</p>
                <h2>오늘의 구매</h2>
                <p>언제 살지 고민하지 않도록 마감일과 우선순위에 따라 지금 볼 항목부터 모았어요.</p>
              </div>
              <div className="today-date">{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(new Date())}</div>
            </div>
            <div className="today-grid">
              {todayGroups.map((group, index) => (
                <section className={`today-group group-${index}`} key={group.title}>
                  <div className="today-group-title">
                    <div>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <h3>{group.title}</h3>
                    </div>
                    <b>{group.items.length}</b>
                  </div>
                  <p>{group.description}</p>
                  {group.items.length === 0 ? (
                    <div className="group-empty">해당하는 항목이 없어요.</div>
                  ) : group.items.map((item) => (
                    <article className="today-item" key={item.id}>
                      <div>
                        <Badge tone={item.priority === "높음" ? "red" : "neutral"}>{item.priority || "중간"}</Badge>
                        <h4>{item.name}</h4>
                        <small>{item.eventName}</small>
                      </div>
                      <p><b>이유</b> {item.status === "purchased" ? `${formatDate(item.purchasedAt?.slice(0, 10))}에 구매를 마쳤어요.` : buildTodayReason(item)}</p>
                      {item.status !== "purchased" && (
                        <button className="text-button" onClick={() => togglePurchased(item.id)}>구매 완료로 표시 →</button>
                      )}
                    </article>
                  ))}
                </section>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer>살뜰 <span>·</span> 가족의 장보기를 기억 대신 실행으로</footer>

      {editingListItem && (
        <div className="modal-backdrop" onMouseDown={() => setEditingListItem(null)}>
          <section className="modal edit-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><h2>구매 항목 수정</h2><button className="icon-button" onClick={() => setEditingListItem(null)}>×</button></div>
            <ItemEditor item={editingListItem} onSave={updateListItem} onCancel={() => setEditingListItem(null)} compact />
          </section>
        </div>
      )}
      {recommendationItem && (
        <RecommendationModal
          item={recommendationItem}
          onClose={() => setRecommendationItem(null)}
          onSelect={(product) => {
            setPurchaseList((current) => current.map((item) => (item.id === recommendationItem.id ? { ...item, selectedProduct: product } : item)));
            setRecommendationItem(null);
          }}
        />
      )}
    </div>
  );
}

function buildTodayReason(item) {
  const diff = dateDiff(item.purchaseDeadline);
  if (!item.purchaseDeadline) return "구매 마감일을 확인하면 더 알맞은 시점에 알려 드릴 수 있어요.";
  if (diff < 0) return `구매 마감일이 ${Math.abs(diff)}일 지났어요. 일정에 필요한 물품인지 먼저 확인해 주세요.`;
  if (diff === 0) return "구매 마감일이 오늘이에요. 배송과 준비 시간을 고려해 오늘 확인하는 것이 좋아요.";
  if (diff <= 3) return `구매 마감까지 ${diff}일 남았어요. 배송 시간을 고려해 미리 골라 두는 것이 좋아요.`;
  return `구매 마감까지 ${diff}일 남았어요. 서두르지 않아도 되지만 여유 있을 때 살펴보세요.`;
}

export default App;
