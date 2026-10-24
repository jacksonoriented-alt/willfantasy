import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import "./AdminConsole.css";

type ConsoleMode = "admin" | "agent";
type Panel = "overview" | "users" | "agents" | "money" | "matches" | "audit";
type Summary = {
  updatedAt: string;
  providers: { payments: string; cricketData: string };
  registrations: { total: number; today: number; thisWeek: number; thisMonth: number };
  users: { active: number; suspended: number };
  deposits: { totalRequests: number; pending: number; underReview: number; approved: number; rejected: number; escalated: number };
  withdrawals: { totalRequests: number; pending: number };
  walletLiabilitiesMinor: { INR: string; USDT: string };
  financials: {
    currency: string;
    approvedDepositsMinor: string;
    pendingDepositsMinor: string;
    grossContestEntryFeesMinor: string;
    refundsMinor: string;
    platformCommissionMinor: string;
    expensesMinor: string;
    netProfitMinor: string;
  }[];
  contestPrizesRecordedMinor: string;
  matches: { enabled: number; live: number; upcoming: number };
  contests: { active: number; participants: number };
  chart: {
    date: string;
    registrations: number;
    approvedDepositMinor: string;
    rejectedDeposits: number;
    contestParticipants: number;
    contestEntryFeesMinor: string;
    commissionMinor: string;
    expensesMinor: string;
  }[];
  recentRegistrations: User[];
  pendingDeposits: Deposit[];
  pendingWithdrawals: Withdrawal[];
  recentContestActivity: { id: string; joinedAt: string; contest: { id: string; name: string; status: string }; user: { id: string; fantasyName: string } }[];
  recentTransactions: { id: string; type: string; amountMinor: string; currency: string; reference: string | null; createdAt: string; user: { id: string; email: string; fantasyName: string } }[];
};
type User = {
  id: string;
  email: string;
  fantasyName: string;
  role: string;
  accountStatus: string;
  createdAt?: string;
};
type Deposit = {
  id: string;
  amountMinor: string;
  currency: string;
  paymentMethod: string;
  paymentReference: string;
  status: string;
  duplicateReference?: boolean;
  decisionReason?: string | null;
  createdAt: string;
  assignedAgent?: { id: string; email: string; fantasyName: string } | null;
  user: { id: string; email: string; fantasyName: string };
};
type Withdrawal = {
  id: string;
  amountMinor: string;
  currency: string;
  payoutMethod?: string;
  status: string;
  createdAt: string;
  user: { id: string; email: string; fantasyName: string };
};
type Match = {
  id: string;
  title: string;
  startsAt: string;
  status: string;
  provider: string | null;
  externalFixtureId: string | null;
  competition: string | null;
  format: string | null;
  isEnabled: boolean;
  isSuspended: boolean;
  archivedAt: string | null;
  readiness: string;
  playersLastSyncedAt: string | null;
  playersSyncError: string | null;
  playingXIConfirmed: boolean;
  playingXILastSyncedAt: string | null;
  playingXISyncError: string | null;
  participantTeams: { id: string; name: string; shortName: string; playerCount: number }[];
  lastSyncedAt: string | null;
  syncError: string | null;
  linkedContests: number;
  savedTeams: number;
};
type Agent = {
  id: string;
  active: boolean;
  transactionLimitMinor: string | null;
  permissions: string[];
  activity: { today: number; thisMonth: number; claimsThisMonth: number; rejectionsThisMonth: number; escalationsThisMonth: number };
  createdAt: string;
  user: User;
};
type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  eventHash: string;
  createdAt: string;
  actor: { id: string; email: string; fantasyName: string } | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

function formatAmount(minor: string | bigint, currency = "INR") {
  const value = BigInt(minor);
  if (currency === "USDT") {
    const major = value / 1_000_000n;
    const fraction = String(value % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
    return `USDT ${major.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  }
  const major = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0");
  return `₹${major.toLocaleString("en-IN")}.${fraction}`;
}

function dateTime(value: string) {
  return new Date(value).toLocaleString();
}

export default function AdminConsole({
  mode,
  superAdmin,
  onClose,
}: {
  mode: ConsoleMode;
  superAdmin: boolean;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(mode === "admin" ? "overview" : "money");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [agentActivity, setAgentActivity] = useState<Agent["activity"] | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [cricketProviderConfigured, setCricketProviderConfigured] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [search, setSearch] = useState("");
  const [matchFilters, setMatchFilters] = useState({
    search: "",
    competition: "",
    format: "",
    status: "",
    from: "",
    to: "",
  });
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError("");
    try {
      if (mode === "agent") {
        const data = await request<{ deposits: Deposit[]; activity: Agent["activity"] }>("/api/agent/deposits");
        setDeposits(data.deposits);
        setAgentActivity(data.activity);
        return;
      }
      const [dashboard, agentData, depositData, withdrawalData, matchData, auditData] = await Promise.all([
        request<Summary>("/api/admin/dashboard"),
        request<{ agents: Agent[] }>("/api/admin/agents"),
        request<{ deposits: Deposit[] }>("/api/admin/deposits?pageSize=50"),
        request<{ withdrawals: Withdrawal[] }>("/api/admin/withdrawals?pageSize=50"),
        request<{ matches: Match[]; providerConfigured: boolean }>("/api/admin/matches"),
        request<{ events: AuditEvent[] }>("/api/admin/audit-events?pageSize=50"),
      ]);
      setSummary(dashboard);
      setAgents(agentData.agents);
      setDeposits(depositData.deposits);
      setWithdrawals(withdrawalData.withdrawals);
      setMatches(matchData.matches);
      setCricketProviderConfigured(matchData.providerConfigured);
      setAuditEvents(auditData.events);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load operations data.");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [load]);

  const inrFinancials = summary?.financials.find((item) => item.currency === "INR");
  async function searchUsers(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: search.trim(), pageSize: "50" });
      const data = await request<{ users: User[] }>(`/api/admin/users?${params}`);
      setUsers(data.users);
      setPanel("users");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Could not search users.");
    } finally {
      setBusy(false);
    }
  }

  async function searchMatches(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      for (const [key, value] of Object.entries(matchFilters)) {
        if (value) params.set(key, value);
      }
      const data = await request<{ matches: Match[]; providerConfigured: boolean }>(`/api/admin/matches?${params}`);
      setMatches(data.matches);
      setCricketProviderConfigured(data.providerConfigured);
    } catch (matchSearchError) {
      setError(matchSearchError instanceof Error ? matchSearchError.message : "Could not search match fixtures.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAccountStatus(user: User, status: string) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/admin/users/${user.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await searchUsers();
      setNotice(`${user.email} is now ${status.toLowerCase()}.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update the account.");
    } finally {
      setBusy(false);
    }
  }

  async function updateUserRole(user: User, role: string) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/admin/users/${user.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      setNotice(`${user.email} role changed to ${role}.`);
      await searchUsers();
    } catch (roleError) {
      setError(roleError instanceof Error ? roleError.message : "Could not update the user role.");
    } finally {
      setBusy(false);
    }
  }

  async function assignAgent(user: User) {
    setBusy(true);
    setError("");
    try {
      await request("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          permissions: ["review_deposits", "reject_deposits", "escalate_deposits"],
        }),
      });
      setNotice(`Cash-agent access assigned to ${user.email}.`);
      await load();
      const data = await request<{ users: User[] }>(`/api/admin/users?search=${encodeURIComponent(search.trim())}&pageSize=50`);
      setUsers(data.users);
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "Could not assign the cash agent.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAgent(agent: Agent) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/admin/agents/${agent.user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !agent.active }),
      });
      await load();
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : "Could not update the agent.");
    } finally {
      setBusy(false);
    }
  }

  async function updateMatch(match: Match, change: { isEnabled?: boolean; isSuspended?: boolean; archived?: boolean }) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/admin/matches/${match.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      setNotice(`${match.title} updated.`);
      await load();
    } catch (matchError) {
      setError(matchError instanceof Error ? matchError.message : "Could not update the match.");
    } finally {
      setBusy(false);
    }
  }

  async function syncCricketMatches() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{ received: number; created: number; updated: number }>("/api/admin/matches/sync", {
        method: "POST",
      });
      await load();
      setNotice(`CricketLiveAPI sync complete: ${result.received} received, ${result.created} new, ${result.updated} updated. Matches remain unpublished until approved.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Could not sync CricketLiveAPI matches.");
    } finally {
      setBusy(false);
    }
  }

  async function syncCricketPlayers(match: Match) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{
        imported: number;
        received: number;
        ready: boolean;
        errors: string[];
        playingXIConfirmed: boolean;
        playingXIError: string | null;
      }>(`/api/admin/matches/${match.id}/sync-players`, { method: "POST" });
      await load();
      setNotice(
        `${match.title}: ${result.imported}/${result.received} players imported; player pool ${result.ready ? "ready" : "incomplete"}; playing XI ${result.playingXIConfirmed ? "confirmed" : "not confirmed"}.` +
        (result.errors.length ? ` ${result.errors.join(" ")}` : "") +
        (result.playingXIError ? ` Playing XI: ${result.playingXIError}` : ""),
      );
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Could not sync CricketLiveAPI players.");
    } finally {
      setBusy(false);
    }
  }

  async function recordExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/api/admin/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountMinor: expenseAmount,
          currency: "INR",
          category: expenseCategory.trim(),
          idempotencyKey: `expense:${crypto.randomUUID()}`,
        }),
      });
      setExpenseAmount("");
      setExpenseCategory("");
      setNotice("Platform expense recorded and audited.");
      await load();
    } catch (expenseError) {
      setError(expenseError instanceof Error ? expenseError.message : "Could not record the expense.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyAuditChain() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ valid: boolean; checked: number }>("/api/admin/audit-events/verify", {
        method: "POST",
      });
      setNotice(result.valid
        ? `Audit chain verified: ${result.checked} events checked.`
        : `Audit-chain integrity check failed after ${result.checked} events.`);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Could not verify the audit chain.");
    } finally {
      setBusy(false);
    }
  }

  async function approveDeposit(deposit: Deposit) {
    if (deposit.duplicateReference) {
      setError("This payment reference is duplicated. Investigate it before approving.");
      return;
    }

    if (!window.confirm(
      `Approve ${formatAmount(deposit.amountMinor, deposit.currency)} for ${deposit.user.fantasyName}? Confirm you independently verified the payment in your bank or payment provider.`
    )) return;

    const verifiedPaymentReference = window.prompt(
      "Enter the exact payment reference verified in your payment provider:",
      deposit.paymentReference
    );
    if (verifiedPaymentReference === null || !verifiedPaymentReference.trim()) return;

    const reason = window.prompt(
      "Enter the verification reason (10–500 characters):"
    );
    if (reason === null || reason.trim().length < 10 || reason.trim().length > 500) {
      setError("Approval cancelled: the verification reason must be 10–500 characters.");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");

    try {
      await request(`/api/admin/deposits/${encodeURIComponent(deposit.id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentVerified: true,
          verifiedPaymentReference: verifiedPaymentReference.trim(),
          reason: reason.trim(),
        }),
      });
      setNotice(`Deposit approved for ${deposit.user.fantasyName}.`);
      await load();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "Could not approve this deposit.");
    } finally {
      setBusy(false);
    }
  }

  async function agentAction(deposit: Deposit, action: "claim" | "reject" | "escalate") {
    setBusy(true);
    setError("");
    try {
      const reason = action === "claim" ? undefined : window.prompt(
        action === "reject" ? "Reason this payment could not be verified:" : "Reason this payment needs administrator review:",
      );
      if (action !== "claim" && !reason?.trim()) return;
      await request(`/api/agent/deposits/${deposit.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "claim" ? undefined : JSON.stringify({ reason }),
      });
      setNotice(`Deposit ${action === "claim" ? "claimed" : action === "reject" ? "rejected" : "escalated"}.`);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update the deposit.");
    } finally {
      setBusy(false);
    }
  }

  const links = useMemo(() => mode === "admin"
    ? [
      ["overview", "Overview"],
      ["users", "Users"],
      ["agents", "Cash agents"],
      ["money", "Deposits & withdrawals"],
      ["matches", "Match manager"],
      ["audit", "Audit history"],
    ] as const
    : [["money", "Deposit review"]] as const, [mode]);

  return (
    <div className="admin-console-backdrop" role="dialog" aria-modal="true" aria-label={mode === "admin" ? "Admin console" : "Cash agent panel"}>
      <section className="admin-console">
        <header className="admin-console-header">
          <div>
            <span className="eyebrow">{mode === "admin" ? "PLATFORM OPERATIONS" : "CASH AGENT"}</span>
            <h2>{mode === "admin" ? "Admin console" : "Deposit review queue"}</h2>
            <p>Updated from stored records · auto-refresh every 30 seconds</p>
          </div>
          <button className="saved-nav" onClick={onClose} aria-label="Close operations panel">Close</button>
        </header>
        <div className="admin-console-body">
          <nav className="admin-console-tabs" aria-label="Operations sections">
            {links.map(([id, label]) => (
              <button key={id} type="button" className={panel === id ? "active" : ""} onClick={() => setPanel(id)}>{label}</button>
            ))}
          </nav>
          {error && <div className="message error">{error}</div>}
          {notice && <div className="message success">{notice}<button type="button" onClick={() => setNotice("")}>Dismiss</button></div>}
          {loading && <div className="message">Loading operational records…</div>}

          {mode === "admin" && panel === "overview" && summary && (
            <>
              <div className="provider-status-row">
                <span>Payment verification <b className="status-disabled">Not configured</b></span>
                <span>Cricket data <b className={summary.providers.cricketData === "CONFIGURED" ? "" : "status-disabled"}>{summary.providers.cricketData === "CONFIGURED" ? "CricketLiveAPI configured" : "Not configured"}</b></span>
                <a href="/api/admin/financial-report.csv" className="saved-nav">Export financial report</a>
              </div>
              <div className="admin-kpi-grid">
                <Kpi label="Registered users" value={summary.registrations.total} sub={`+${summary.registrations.today} today · +${summary.registrations.thisWeek} this week`} />
                <Kpi label="Active / suspended" value={`${summary.users.active} / ${summary.users.suspended}`} sub={`${summary.registrations.thisMonth} registrations this month`} />
                <Kpi label="Deposit requests" value={summary.deposits.totalRequests} sub={`${summary.deposits.approved} approved · ${summary.deposits.rejected} rejected`} />
                <Kpi label="Awaiting verification" value={summary.deposits.pending + summary.deposits.underReview + summary.deposits.escalated} sub={`${summary.deposits.pending} pending · ${summary.deposits.escalated} escalated`} />
                <Kpi label="Approved deposits" value={formatAmount(inrFinancials?.approvedDepositsMinor ?? "0")} sub={`${summary.deposits.approved} verified requests · INR`} />
                <Kpi label="Pending withdrawals" value={summary.withdrawals.pending} sub={`${summary.withdrawals.totalRequests} total requests`} />
                <Kpi label="Wallet liabilities" value={formatAmount(summary.walletLiabilitiesMinor.INR)} sub={`USDT ${formatAmount(summary.walletLiabilitiesMinor.USDT, "USDT").replace("USDT ", "")}`} />
                <Kpi label="Contest entry fees" value={formatAmount(inrFinancials?.grossContestEntryFeesMinor ?? "0")} sub="Actual ledger records only" />
                <Kpi label="Commission earned" value={formatAmount(inrFinancials?.platformCommissionMinor ?? "0")} sub="Recorded commission, not total entry pool" />
                <Kpi label="Net profit recorded" value={formatAmount(inrFinancials?.netProfitMinor ?? "0")} sub={`Refunds ${formatAmount(inrFinancials?.refundsMinor ?? "0")} · expenses ${formatAmount(inrFinancials?.expensesMinor ?? "0")}`} />
                <Kpi label="Prize records" value={formatAmount(summary.contestPrizesRecordedMinor)} sub="Recorded prize obligations; payouts unavailable" />
                <Kpi label="Matches / contests" value={`${summary.matches.enabled} / ${summary.contests.active}`} sub={`${summary.matches.live} live · ${summary.matches.upcoming} upcoming · ${summary.contests.participants} participants`} />
              </div>
              <p className="admin-accounting-note">Deposits are counted as received only after their status is Approved. Wallet liabilities include available and reserved balances; they are not revenue. Net profit is recorded commission minus recorded expenses. Pending deposits and unverified payments are excluded.</p>
              {superAdmin && <form className="admin-expense-form" onSubmit={(event) => void recordExpense(event)}>
                <strong>Record platform expense · INR paise</strong>
                <label>Expense amount<input required inputMode="numeric" pattern="[1-9][0-9]*" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} /></label>
                <label>Category<input required maxLength={80} value={expenseCategory} onChange={(event) => setExpenseCategory(event.target.value)} /></label>
                <button className="saved-nav" disabled={busy}>Record expense</button>
              </form>}
              <div className="admin-chart-grid">
                <Chart title="Registrations · 30 days" values={summary.chart.map((point) => point.registrations)} labels={summary.chart.map((point) => point.date)} />
                <Chart title="Approved deposit volume · INR" values={summary.chart.map((point) => point.approvedDepositMinor)} labels={summary.chart.map((point) => point.date)} />
                <Chart title="Rejected deposits · requests" values={summary.chart.map((point) => point.rejectedDeposits)} labels={summary.chart.map((point) => point.date)} />
                <Chart title="Contest participation · 30 days" values={summary.chart.map((point) => point.contestParticipants)} labels={summary.chart.map((point) => point.date)} />
                <Chart title="Contest entry-fee volume · INR" values={summary.chart.map((point) => point.contestEntryFeesMinor)} labels={summary.chart.map((point) => point.date)} />
                <Chart title="Platform commission · INR" values={summary.chart.map((point) => point.commissionMinor)} labels={summary.chart.map((point) => point.date)} />
              </div>
              <div className="admin-tables-grid">
                <section className="admin-table-card">
                  <h3>Recent registrations</h3>
                  {summary.recentRegistrations.map((user) => <div className="admin-table-row" key={user.id}><span>{user.fantasyName}<small>{user.email}</small></span><span>{user.role} · {user.accountStatus}</span><time>{user.createdAt ? dateTime(user.createdAt) : "—"}</time></div>)}
                </section>
                <section className="admin-table-card">
                  <h3>Pending deposit review <small>Not counted as received</small></h3>
                  {summary.pendingDeposits.map((deposit) => <div className="admin-table-row" key={deposit.id}><span>{deposit.user.fantasyName}<small>{deposit.paymentMethod} · {deposit.paymentReference}</small></span><span>{formatAmount(deposit.amountMinor, deposit.currency)}</span><time>{deposit.status}</time></div>)}
                  {summary.pendingDeposits.length === 0 && <p className="admin-empty">No pending deposit requests.</p>}
                </section>
              </div>
              <div className="admin-tables-grid">
                <section className="admin-table-card">
                  <h3>Pending withdrawals</h3>
                  {summary.pendingWithdrawals.map((withdrawal) => <div className="admin-table-row" key={withdrawal.id}><span>{withdrawal.user.fantasyName}<small>{withdrawal.user.email}</small></span><span>{formatAmount(withdrawal.amountMinor, withdrawal.currency)}</span><time>{withdrawal.status}</time></div>)}
                  {summary.pendingWithdrawals.length === 0 && <p className="admin-empty">No pending withdrawals.</p>}
                </section>
                <section className="admin-table-card">
                  <h3>Recent contest activity</h3>
                  {summary.recentContestActivity.map((entry) => <div className="admin-table-row" key={entry.id}><span>{entry.user.fantasyName}<small>{entry.contest.name}</small></span><span>{entry.contest.status}</span><time>{dateTime(entry.joinedAt)}</time></div>)}
                  {summary.recentContestActivity.length === 0 && <p className="admin-empty">No contest participation recorded.</p>}
                </section>
              </div>
              <section className="admin-table-card">
                <h3>Recent financial ledger transactions</h3>
                {summary.recentTransactions.map((transaction) => <div className="admin-table-row" key={transaction.id}><span>{transaction.type}<small>{transaction.user.fantasyName} · {transaction.reference ?? "No reference"}</small></span><span>{formatAmount(transaction.amountMinor, transaction.currency)}</span><time>{dateTime(transaction.createdAt)}</time></div>)}
                {summary.recentTransactions.length === 0 && <p className="admin-empty">No wallet ledger entries recorded.</p>}
              </section>
            </>
          )}

          {mode === "admin" && panel === "users" && (
            <>
              <form className="admin-search-form" onSubmit={(event) => void searchUsers(event)}>
                <label>Search by email or fantasy name<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={120} /></label>
                <button className="saved-nav" disabled={busy}>Search</button>
              </form>
              <div className="admin-table-card">
                <h3>User accounts</h3>
                {users.map((user) => <div className="admin-table-row" key={user.id}>
                  <span>{user.fantasyName}<small>{user.email} · ID {user.id}</small></span>
                  <span>{user.role} · {user.accountStatus}</span>
                  <div className="admin-row-actions">
                    {user.role === "USER" && <button className="saved-nav" disabled={busy} onClick={() => void assignAgent(user)}>Assign cash-agent role</button>}
                    {user.role === "USER" && <button className="saved-nav" disabled={busy} onClick={() => void updateAccountStatus(user, user.accountStatus === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>{user.accountStatus === "ACTIVE" ? "Suspend" : "Reactivate"}</button>}
                    {superAdmin && user.role === "USER" && <button className="saved-nav" disabled={busy} onClick={() => void updateUserRole(user, "ADMIN")}>Promote to admin</button>}
                    {superAdmin && user.role === "ADMIN" && <button className="saved-nav" disabled={busy} onClick={() => void updateUserRole(user, "USER")}>Remove admin role</button>}
                  </div>
                </div>)}
                {users.length === 0 && <p className="admin-empty">Search for a registered user to manage their account or agent access.</p>}
              </div>
            </>
          )}

          {mode === "admin" && panel === "agents" && (
            <div className="admin-table-card">
              <h3>Cash agent assignments</h3>
              <p className="admin-accounting-note">Agents are assigned to an already-registered account. Access can review, reject with a reason, or escalate requests; no agent can approve a payment or edit financial records.</p>
              {agents.map((agent) => <div className="admin-table-row" key={agent.id}>
                <span>{agent.user.fantasyName}<small>{agent.user.email} · {agent.user.id}</small></span>
                <span>{agent.active ? "Active" : "Deactivated"} · {agent.permissions.join(", ") || "No permissions"}<small>{agent.activity.today} today · {agent.activity.claimsThisMonth} claims · {agent.activity.rejectionsThisMonth} rejected · {agent.activity.escalationsThisMonth} escalated this month</small></span>
                <button className="saved-nav" disabled={busy || !agent.active} onClick={() => void toggleAgent(agent)}>{agent.active ? "Deactivate" : "Inactive"}</button>
              </div>)}
              {agents.length === 0 && <p className="admin-empty">No cash agents assigned. Search a registered account in Users to assign one.</p>}
            </div>
          )}

          {mode === "admin" && panel === "money" && (
            <div className="admin-tables-grid">
              <section className="admin-table-card">
                <h3>Deposit requests</h3>
                <p className="admin-accounting-note">Development testing: independently verify each payment in your payment provider before approving. Duplicate references cannot be approved from this screen.</p>
                {deposits.map((deposit) => <div className="admin-table-row" key={deposit.id}>
                  <span>{deposit.user.fantasyName}<small>{deposit.paymentMethod} · {deposit.paymentReference}{deposit.duplicateReference ? " · DUPLICATE REFERENCE" : ""}</small></span>
                  <span>{formatAmount(deposit.amountMinor, deposit.currency)}</span>
                  <span>{deposit.status}{deposit.assignedAgent ? ` · ${deposit.assignedAgent.fantasyName}` : ""}</span>
                  <div className="admin-row-actions">
                    {["PENDING", "UNDER_REVIEW", "ESCALATED"].includes(deposit.status) && (
                      <button type="button" className="saved-nav" disabled={busy || !!deposit.duplicateReference} onClick={() => void approveDeposit(deposit)}>Approve</button>
                    )}
                  </div>
                </div>)}
                {deposits.length === 0 && <p className="admin-empty">No deposit requests.</p>}
              </section>
              <section className="admin-table-card">
                <h3>Withdrawal requests</h3>
                <p className="admin-accounting-note">Payout execution and withdrawal requests are disabled until a payout provider is integrated.</p>
                {withdrawals.map((withdrawal) => <div className="admin-table-row" key={withdrawal.id}><span>{withdrawal.user.fantasyName}<small>{withdrawal.payoutMethod ?? "Payout method withheld"}</small></span><span>{formatAmount(withdrawal.amountMinor, withdrawal.currency)}</span><span>{withdrawal.status}</span></div>)}
                {withdrawals.length === 0 && <p className="admin-empty">No withdrawal requests.</p>}
              </section>
            </div>
          )}

          {mode === "admin" && panel === "matches" && (
            <div className="admin-table-card">
              <h3>Match publication</h3>
              <p className="admin-accounting-note">CricketLiveAPI fixtures are imported as unpublished drafts. Sync the provider player pool before publishing. Confirmed playing XI is tracked separately and is not required for player-pool readiness.</p>
              <div className="provider-status-row">
                <span>CricketLiveAPI <b className={cricketProviderConfigured ? "" : "status-disabled"}>{cricketProviderConfigured ? "Configured" : "Not configured"}</b></span>
                <button type="button" className="saved-nav" disabled={busy || !cricketProviderConfigured} onClick={() => void syncCricketMatches()}>Sync matches</button>
              </div>
              <form className="admin-match-search" onSubmit={(event) => void searchMatches(event)}>
                <label>Fixture or team<input value={matchFilters.search} onChange={(event) => setMatchFilters((current) => ({ ...current, search: event.target.value }))} /></label>
                <label>Competition<input value={matchFilters.competition} onChange={(event) => setMatchFilters((current) => ({ ...current, competition: event.target.value }))} /></label>
                <label>Format<input value={matchFilters.format} onChange={(event) => setMatchFilters((current) => ({ ...current, format: event.target.value }))} /></label>
                <label>Status<select value={matchFilters.status} onChange={(event) => setMatchFilters((current) => ({ ...current, status: event.target.value }))}><option value="">All statuses</option>{["UPCOMING", "LIVE", "IN_PROGRESS", "COMPLETED", "CANCELLED", "ABANDONED", "POSTPONED"].map((status) => <option key={status}>{status}</option>)}</select></label>
                <label>From<input type="date" value={matchFilters.from} onChange={(event) => setMatchFilters((current) => ({ ...current, from: event.target.value }))} /></label>
                <label>To<input type="date" value={matchFilters.to} onChange={(event) => setMatchFilters((current) => ({ ...current, to: event.target.value }))} /></label>
                <button className="saved-nav" disabled={busy}>Search fixtures</button>
              </form>
              {matches.map((match) => <div className="admin-match-row" key={match.id}>
                <div>
                  <strong>{match.title}</strong>
                  <span>{match.competition ?? "Competition unavailable"} · {match.format ?? "Format unavailable"} · {dateTime(match.startsAt)}</span>
                  <span>{match.provider ?? "No provider"}{match.externalFixtureId ? ` · Fixture ${match.externalFixtureId}` : ""} · {match.readiness}</span>
                  <span>{match.participantTeams.map((team) => `${team.name} (${team.playerCount} players)`).join(" · ") || "Squads unavailable"}</span>
                  <span>Playing XI: {match.playingXIConfirmed ? "Confirmed" : "Not confirmed"}</span>
                  {match.playersSyncError && <span className="status-disabled">{match.playersSyncError}</span>}
                  {match.playingXISyncError && <span className="status-disabled">{match.playingXISyncError}</span>}
                  {match.playersLastSyncedAt && <span>Players synced {dateTime(match.playersLastSyncedAt)}</span>}
                  {match.syncError && <span className="status-disabled">{match.syncError}</span>}
                  {match.lastSyncedAt && <span>Last sync {dateTime(match.lastSyncedAt)}</span>}
                  <small>{match.linkedContests} contests · {match.savedTeams} saved teams</small>
                </div>
                <div className="admin-row-actions">
                  <b>{match.archivedAt ? "Archived" : match.isSuspended ? "Suspended" : match.isEnabled ? "Published" : match.readiness}</b>
                  <button className="saved-nav" disabled={busy || match.provider !== "CRICKETLIVEAPI" || !match.externalFixtureId || Boolean(match.archivedAt)} onClick={() => void syncCricketPlayers(match)}>Sync players / XI</button>
                  <button className="saved-nav" disabled={busy || match.readiness !== "READY" || Boolean(match.archivedAt)} onClick={() => void updateMatch(match, { isEnabled: !match.isEnabled })}>{match.isEnabled ? "Disable" : "Publish"}</button>
                  <button className="saved-nav" disabled={busy || Boolean(match.archivedAt)} onClick={() => void updateMatch(match, { isSuspended: !match.isSuspended })}>{match.isSuspended ? "Unsuspend" : "Suspend"}</button>
                  <button className="saved-nav" disabled={busy || Boolean(match.archivedAt)} onClick={() => void updateMatch(match, { archived: true })}>Archive</button>
                </div>
              </div>)}
              {matches.length === 0 && <p className="admin-empty">No imported fixtures are available.</p>}
            </div>
          )}

          {mode === "admin" && panel === "audit" && (
            <div className="admin-table-card">
              <h3>Tamper-evident audit history</h3>
              {superAdmin && <button type="button" className="saved-nav" disabled={busy} onClick={() => void verifyAuditChain()}>Verify full audit chain</button>}
              {auditEvents.map((event) => <div className="admin-table-row" key={event.id}>
                <span>{event.action}<small>{event.entityType}{event.entityId ? ` · ${event.entityId}` : ""} · {event.actor?.email ?? "System"}</small></span>
                <code title={event.eventHash}>{event.eventHash.slice(0, 18)}…</code>
                <time>{dateTime(event.createdAt)}</time>
              </div>)}
              {auditEvents.length === 0 && <p className="admin-empty">No administrative actions recorded yet.</p>}
            </div>
          )}

          {mode === "agent" && panel === "money" && (
            <div className="admin-table-card">
              <h3>Deposit review queue <span className="status-disabled">Approval disabled</span></h3>
              <p className="admin-accounting-note">Check payment against the actual authorized payment source. Uploaded screenshots alone are never proof. Approval remains unavailable until provider verification is integrated.</p>
              {agentActivity && <div className="provider-status-row"><span>Actions today <b>{agentActivity.today}</b></span><span>Actions this month <b>{agentActivity.thisMonth}</b></span><span>Claims {agentActivity.claimsThisMonth} · rejected {agentActivity.rejectionsThisMonth} · escalated {agentActivity.escalationsThisMonth}</span></div>}
              {deposits.map((deposit) => <div className="admin-agent-deposit" key={deposit.id}>
                <div><strong>{deposit.user.fantasyName}</strong><span>User {deposit.user.id} · {deposit.user.email}</span><span>{formatAmount(deposit.amountMinor, deposit.currency)} · {deposit.paymentMethod}</span><span>Reference {deposit.paymentReference} · {dateTime(deposit.createdAt)}</span>{deposit.duplicateReference && <b className="status-disabled">Duplicate payment reference — escalate</b>}<b>{deposit.status}</b></div>
                <div className="admin-row-actions">
                  {deposit.status === "PENDING" && <button className="saved-nav" disabled={busy} onClick={() => void agentAction(deposit, "claim")}>Claim</button>}
                  {deposit.status === "UNDER_REVIEW" && <>
                    <button className="saved-nav" disabled={busy} onClick={() => void agentAction(deposit, "reject")}>Reject</button>
                    <button className="saved-nav" disabled={busy} onClick={() => void agentAction(deposit, "escalate")}>Escalate</button>
                  </>}
                </div>
              </div>)}
              {deposits.length === 0 && <p className="admin-empty">No deposit requests are awaiting review.</p>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return <article className="admin-kpi"><span>{label}</span><strong>{value}</strong><small>{sub}</small></article>;
}

function Chart({ title, values, labels }: { title: string; values: (number | string)[]; labels: string[] }) {
  const moneyValues = values.every((value) => typeof value === "string");
  const bigintValues = moneyValues ? values.map((value) => BigInt(value)) : [];
  const maxBigint = bigintValues.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  const maxNumber = moneyValues ? 0 : Math.max(1, ...values.map((value) => Number(value)));
  return (
    <section className="admin-chart-card">
      <h3>{title}</h3>
      <div className="admin-chart-bars" role="img" aria-label={`${title} daily chart`}>
        {values.map((value, index) => {
          const height = moneyValues
            ? maxBigint > 0n ? Number((BigInt(value) * 10_000n) / maxBigint) / 100 : 0
            : Number(value) / maxNumber * 100;
          const displayValue = typeof value === "string" ? formatAmount(value) : value.toLocaleString();
          return (
          <span
            key={labels[index]}
            title={`${labels[index]}: ${displayValue}`}
            style={{ height: `${Math.max(2, height)}%` }}
          />
          );
        })}
      </div>
      <div className="admin-chart-labels"><span>{labels[0]}</span><span>{labels.at(-1)}</span></div>
    </section>
  );
}
