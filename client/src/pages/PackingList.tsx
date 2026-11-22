import { useEffect, useMemo, useRef, useState } from "react";
import { getPackingPlan, setPackingCheck, type PackingPlan } from "../api";
import { useLang } from "../i18n/useLang";
import PackingLayout from "./PackingListView";

// The packing-list screen (sketch: 打包清单 + 造型/精简 slider + 重要物品提醒
// + 核心单品 cards). All packing logic is on the server (AGENTS.md §3); this
// screen only renders the plan, tracks which items the user has ticked off,
// and sends the slider value back to regenerate. Serves US 6.1–6.3 and 7.1.

/** Debounce the slider so dragging doesn't fire a request per pixel. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Props = {
  tripPlanId: string;
  onBack: () => void;
};

export default function PackingList({ tripPlanId, onBack }: Props) {
  const { t } = useLang();
  // 0 = pack lightest · 100 = most variety. The sketch draws the slider
  // vertically with "more variety" on top, so the visual top is 100.
  const [balance, setBalance] = useState(() =>
    Number(sessionStorage.getItem("wearroute_packing_balance") ?? 50)
  );
  const debouncedBalance = useDebounced(balance, 250);

  const [plan, setPlan] = useState<PackingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Ticked items come back with the plan: they are stored per trip on the
  // server, so they survive a closed tab and match the iOS app (US 7.1).
  useEffect(() => {
    sessionStorage.setItem("wearroute_packing_balance", String(balance));
  }, [balance]);

  // Guards against out-of-order responses when the slider moves quickly.
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    getPackingPlan(debouncedBalance, tripPlanId)
      .then(({ plan }) => {
        if (id !== reqId.current) return;
        setPlan(plan);
        setError(null);
      })
      .catch((err) => {
        if (id !== reqId.current) return;
        setError(err instanceof Error ? err.message : t("pkLoadFailed"));
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [debouncedBalance, tripPlanId]);

  const checked = useMemo(
    () => Object.fromEntries((plan?.checked ?? []).map((id) => [id, true])),
    [plan]
  );

  function toggle(itemId: string) {
    if (!plan) return;
    const id = ++reqId.current;
    setPackingCheck(tripPlanId, itemId, !checked[itemId], debouncedBalance)
      .then(({ plan: updated }) => {
        if (id !== reqId.current) return;
        setPlan(updated);
        setError(null);
      })
      .catch((err) => {
        if (id !== reqId.current) return;
        setError(err instanceof Error ? err.message : t("pkLoadFailed"));
      });
  }

  return (
    <PackingLayout
      balance={balance}
      onBalance={setBalance}
      plan={plan}
      loading={loading}
      error={error}
      checked={checked}
      onToggle={toggle}
      totalItems={plan?.totalCount ?? 0}
      packedCount={plan?.packedCount ?? 0}
      onBack={onBack}
    />
  );
}
