import { useEffect, useState } from "react";
import "./FundsPanel.css";

type WalletSummary = {
  wallets: { currency: string; availableMinor: string; reservedMinor: string }[];
  paymentStatus: string;
  message: string;
};
type RequestHistory = {
  id: string;
  amountMinor: string;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  decisionReason?: string | null;
  paymentMethod?: string;
  paymentReference?: string;
  payoutReference?: string | null;
};

async function getData<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Could not load wallet information.");
  return data;
}

function formatMinor(amount: string, currency: string) {
  const value = BigInt(amount);
  if (currency === "USDT") {
    const major = value / 1_000_000n;
    const decimal = String(value % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
    return `USDT ${major.toLocaleString("en-US")}${decimal ? `.${decimal}` : ""}`;
  }
  return `₹${(value / 100n).toLocaleString("en-IN")}.${String(value % 100n).padStart(2, "0")}`;
}

export default function FundsPanel({ onClose }: { onClose: () => void }) {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [deposits, setDeposits] = useState<RequestHistory[]>([]);
  const [withdrawals, setWithdrawals] = useState<RequestHistory[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [paymentReference, setPaymentReference] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([
        getData<WalletSummary>("/api/wallet"),
        getData<{ deposits: RequestHistory[] }>("/api/deposits"),
        getData<{ withdrawals: RequestHistory[] }>("/api/withdrawals"),
      ]).then(([walletData, depositData, withdrawalData]) => {
        setWallet(walletData);
        setDeposits(depositData.deposits);
        setWithdrawals(withdrawalData.withdrawals);
      }).catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Could not load wallet information.");
      }).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submitDeposit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 100000 ||
        Math.round(numericAmount * 100) !== numericAmount * 100) {
      setError("Enter an amount from ₹1 to ₹1,00,000, with at most two decimal places.");
      return;
    }

    const reference = paymentReference.trim();
    if (reference.length < 4 || reference.length > 120 ||
        !/^[A-Za-z0-9._:/-]+$/.test(reference)) {
      setError("Enter a valid payment reference (4–120 letters, numbers, or . _ : / -).");
      return;
    }

    setSubmitting(true);
    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await fetch("/api/deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountMinor: String(Math.round(numericAmount * 100)),
          paymentMethod,
          paymentReference: reference,
          idempotencyKey,
        }),
      });
      const data = await response.json() as {
        error?: string;
        message?: string;
        deposit?: RequestHistory;
      };

      if (!response.ok) {
        throw new Error(data.error || "Could not submit the deposit request.");
      }

      setNotice(data.message || "Deposit request submitted for review.");
      setAmount("");
      setPaymentReference("");

      const [depositData, walletData] = await Promise.all([
        getData<{ deposits: RequestHistory[] }>("/api/deposits"),
        getData<WalletSummary>("/api/wallet"),
      ]);
      setDeposits(depositData.deposits);
      setWallet(walletData);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not submit the deposit request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="funds-panel-backdrop" role="dialog" aria-modal="true" aria-label="Wallet and transaction history">
      <section className="funds-panel">
        <div className="saved-modal-head">
          <div><span className="eyebrow">WALLET & PAYMENTS</span><h2>Your funds</h2></div>
          <button type="button" onClick={onClose} aria-label="Close wallet">✕</button>
        </div>
        <p className="funds-disabled-notice">Submit a deposit request only after you have made a payment through an officially configured receiving account. Your wallet will not be credited until an administrator independently verifies the transaction.</p>
        {error && <div className="message error" role="alert">{error}</div>}
        {notice && <div className="message" role="status">{notice}</div>}
        {loading && <div className="message">Loading your balances and request history…</div>}
        {!loading && wallet && <>
          <div className="funds-balance-grid">
            {(wallet.wallets.length ? wallet.wallets : [{ currency: "INR", availableMinor: "0", reservedMinor: "0" }]).map((item) => (
              <article key={item.currency}><span>{item.currency} available</span><strong>{formatMinor(item.availableMinor, item.currency)}</strong><small>Reserved {formatMinor(item.reservedMinor, item.currency)}</small></article>
            ))}
          </div>
          <form className="funds-deposit-form" onSubmit={(event) => void submitDeposit(event)}>
            <h3>Submit a deposit request</h3>
            <label>Amount (INR)
              <input
                type="number"
                min="1"
                max="100000"
                step="0.01"
                inputMode="decimal"
                placeholder="e.g. 500"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={submitting}
                required
              />
            </label>
            <label>Payment method
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} disabled={submitting}>
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
              </select>
            </label>
            <label>Payment reference / UTR
              <input
                value={paymentReference}
                onChange={(event) => setPaymentReference(event.target.value)}
                placeholder="Enter transaction reference"
                maxLength={120}
                autoComplete="off"
                disabled={submitting}
                required
              />
            </label>
            <p className="funds-form-note">Do not submit a reference for a payment you have not made. Never enter your UPI PIN, password, or OTP here. Submitting this form does not confirm payment or add money to your balance.</p>
            <button type="submit" disabled={submitting || loading}>
              {submitting ? "Submitting…" : "Submit deposit request"}
            </button>
            <button type="button" disabled>Withdraw unavailable</button>
          </form>
          <section className="funds-history">
            <h3>Deposit history</h3>
            {deposits.map((deposit) => <article key={deposit.id}>
              <span>{formatMinor(deposit.amountMinor, deposit.currency)} · {deposit.paymentMethod}<small>{deposit.paymentReference} · {new Date(deposit.createdAt).toLocaleString()}</small></span>
              <b>{deposit.status}</b>
            </article>)}
            {deposits.length === 0 && <p>No deposit requests.</p>}
          </section>
          <section className="funds-history">
            <h3>Withdrawal history</h3>
            {withdrawals.map((withdrawal) => <article key={withdrawal.id}>
              <span>{formatMinor(withdrawal.amountMinor, withdrawal.currency)}<small>{withdrawal.payoutReference ?? withdrawal.decisionReason ?? new Date(withdrawal.createdAt).toLocaleString()}</small></span>
              <b>{withdrawal.status}</b>
            </article>)}
            {withdrawals.length === 0 && <p>No withdrawal requests.</p>}
          </section>
          <small className="funds-status-line">Payment provider status: {wallet.paymentStatus.replaceAll("_", " ").toLowerCase()}.</small>
        </>}
      </section>
    </div>
  );
}
