import { useCallback, useEffect, useState } from "react";

export function parseRoute(pathname = window.location.pathname) {
  const normalized = pathname.replace(/\/+$/, "") || "/";

  if (normalized === "/") return { name: "home" };
  if (normalized === "/memos") return { name: "inbox" };
  if (normalized === "/shopping-list") return { name: "shopping" };

  const analysisMatch = normalized.match(/^\/memos\/([^/]+)\/analysis$/);
  if (analysisMatch) {
    return {
      name: "analysis",
      memoId: decodeURIComponent(analysisMatch[1]),
    };
  }

  const memoDetailMatch = normalized.match(/^\/memos\/([^/]+)$/);
  if (memoDetailMatch) {
    return {
      name: "memoDetail",
      memoId: decodeURIComponent(memoDetailMatch[1]),
    };
  }

  return { name: "notFound" };
}

export function useRouter() {
  const [route, setRoute] = useState(() => parseRoute());

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((pathname, { replace = false } = {}) => {
    if (window.location.pathname !== pathname) {
      const method = replace ? "replaceState" : "pushState";
      window.history[method]({}, "", pathname);
    }
    setRoute(parseRoute(pathname));
    window.scrollTo(0, 0);
  }, []);

  return { route, navigate };
}
