import { useCallback, useEffect, useMemo, useState } from "react";
import AdminConsole from "./AdminConsole";
import FundsPanel from "./FundsPanel";
import "./App.css";

type Match = { id: string; title: string; startsAt: string; status: string; playingXIConfirmed?: boolean; participants?: { cricketTeam: { id: string; name: string; shortName?: string | null } }[] };
type MatchTab = "UPCOMING" | "LIVE" | "COMPLETED";

type CricketTeam = { id: string; name: string; shortName: string };
type Player = {
  id: string;
  name: string;
  role: string;
  creditValue: number;
  cricketTeamId: string;
  cricketTeam: CricketTeam;
  isPlayingXI?: boolean;
};
type SavedTeam = {
  id: string;
  name: string;
  teamNumber: number;
  matchId: string;
  captainId?: string | null;
  viceCaptainId?: string | null;
  selections?: { player: Player }[];
};

type Contest = {
  id: string; name: string; matchId: string;
  type: "WINNER_TAKES_ALL" | "TOP_3" | "TOP_5" | "TOP_10" | "TOP_10_PERCENT" | "TOP_20_PERCENT" | "HEAD_TO_HEAD" | "THREE_MAX" | "SMALL_FIELD" | "MULTI_POSITION";
  entryFee: number; prizePool: number; capacity: number;
  status: string; entryCount: number; joined: boolean; match: Match;
  userEntryCount?: number; enteredFantasyTeamIds?: string[];
  winnerCount: number; prizeBreakdown: PrizeTier[]; maxPrizeBreakdown?: PrizeTier[];
  matchStarted?: boolean;
  sourceType?: "MEGA" | "REGULAR";
  entryFeePaise?: string;
  sponsorContributionPaise?: string;
  targetPrizePoolPaise?: string;
  grossEntryRevenuePaise?: string;
  commissionPaise?: string;
  distributablePrizePaise?: string;
  commissionBps?: number;
  startsAt?: string;
  registrationDeadline?: string | null;
  remainingSlots?: number;
  prizePercentages?: number[];
  prizeMode?: "PERCENTAGE" | "FIXED";
  prizeTemplate?: "MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM" | null;
  fixedPrizeTiers?: PrizeTier[] | null;
};
type PrizeTier = { fromRank: number; toRank: number; prizeRupees: number };
type ContestTemplate = {
  id: string; code: string; name: string; enabled: boolean;
  entryFeePaise: string; capacity: number;
  contestFormat: Contest["type"]; commissionBps: number;
  payoutPercentages: number[]; minimumEntriesToOpen: number;
  registrationLeadMinutes: number; openWindowMinutes: number;
  matchEligibility: Record<string, unknown>;
};
type AdminContestSummary = {
  id: string; name: string; status: string; instanceNumber: number | null;
  match: Match; entryCount: number; capacity: number; grossRevenuePaise: string;
  prizeMode?: "PERCENTAGE" | "FIXED";
  prizeTemplate?: "MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM" | null;
  fixedPrizeTiers?: PrizeTier[] | null;
  commissionPaise: string; prizePoolPaise: string; sponsorContributionPaise: string;
  prizeLiabilityPaise: string; payoutStatus: string;
};
type ContestEntry = {
  id: string; joinedAt: string;
  fantasyTeam: { id: string; name: string };
  contest: Contest;
};
type ContestLeaderboardEntry = {
  id: string;
  joinedAt: string;
  teamName: string;
  fantasyName: string;
};
type ContestLeaderboardResponse = {
  contestId: string;
  status: string;
  entryCount: number;
  reportEligible?: boolean;
  entries: ContestLeaderboardEntry[];
};

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  fantasyName: string;
  role: string;
};

async function requestContests() {
  const response = await fetch("/api/contests");
  const data: { contests?: Contest[]; error?: string } = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load contests.");
  return data.contests ?? [];
}

async function readJsonResponse<T>(response: Response, requestName: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${requestName} returned an empty response (HTTP ${response.status}). Please try again.`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${requestName} returned an invalid response (HTTP ${response.status}). Please try again.`);
  }
}

const roleLabels: Record<string, string> = {
  ALL: "All players",
  WICKETKEEPER: "Wicketkeepers",
  BATTER: "Batters",
  ALL_ROUNDER: "All-rounders",
  BOWLER: "Bowlers",
};
const MAX_CREDITS = 100;
const INITIAL_TIME = Date.now();

function formatRupees(amount: number) {
  return `₹${amount.toLocaleString("en-IN")}`;
}

function getPrizeComparisonRows(current: PrizeTier[], maximum: PrizeTier[]) {
  return {
    current: [...current].sort((a, b) => a.fromRank - b.fromRank),
    maximum: [...maximum].sort((a, b) => a.fromRank - b.fromRank),
  };
}

function formatPaise(value?: string) {
  const paise = BigInt(value ?? "0");
  const rupees = paise / 100n;
  const remainder = String(paise % 100n).padStart(2, "0");
  return `₹${rupees.toLocaleString("en-IN")}.${remainder}`;
}

function toDateTimeInput(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export default function App() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchTab, setMatchTab] = useState<MatchTab>("UPCOMING");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeMatch, setActiveMatch] = useState<Match | null>(null);
  const [builderStep, setBuilderStep] = useState<"contests" | "my-contests" | "team">("contests");
  const [showTeamBuilder, setShowTeamBuilder] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [captain, setCaptain] = useState("");
  const [viceCaptain, setViceCaptain] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [savedTeams, setSavedTeams] = useState<SavedTeam[]>([]);
  const [editingTeamId, setEditingTeamId] = useState("");
  const [showSaved, setShowSaved] = useState(false);
  const [expandedContestId, setExpandedContestId] = useState("");
  const [contestDetailTab, setContestDetailTab] = useState<"leaderboard" | "prizes">("leaderboard");
  const [contestLeaderboard, setContestLeaderboard] = useState<Record<string, ContestLeaderboardEntry[]>>({});
  const [contestReportEligible, setContestReportEligible] = useState<Record<string, boolean>>({});
  const [contestLeaderboardLoading, setContestLeaderboardLoading] = useState<Record<string, boolean>>({});
  const [contestLeaderboardErrors, setContestLeaderboardErrors] = useState<Record<string, string>>({});
  const [contests, setContests] = useState<Contest[]>([]);
  const [contestLoading, setContestLoading] = useState(false);
  const [contestError, setContestError] = useState("");
  const [contestNotice, setContestNotice] = useState("");
  const [joiningContestId, setJoiningContestId] = useState("");
  const [joinTeamSelections, setJoinTeamSelections] = useState<Record<string, string>>({});

  const [contestName, setContestName] = useState("Match contest");
  const [contestType, setContestType] = useState<Contest["type"]>("TOP_10_PERCENT");
  const [contestEntryFee, setContestEntryFee] = useState(100);
  const [contestCapacity, setContestCapacity] = useState(100);
  const [contestCommissionBps, setContestCommissionBps] = useState(2000);
  const [contestPayoutText, setContestPayoutText] = useState("10,10,10,10,10,10,10,10,10,10");
  const [contestPrizeMode, setContestPrizeMode] = useState<"PERCENTAGE" | "FIXED">("PERCENTAGE");
  const [contestPrizeTemplate, setContestPrizeTemplate] = useState<"MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM">("MEGA_JACKPOT");
  const [contestFixedPrizeTiers, setContestFixedPrizeTiers] = useState<PrizeTier[]>([
    { fromRank: 1, toRank: 1, prizeRupees: 10000 },
    { fromRank: 2, toRank: 5, prizeRupees: 2000 },
    { fromRank: 6, toRank: 20, prizeRupees: 500 },
  ]);
  const [contestSponsorRupees, setContestSponsorRupees] = useState(0);
  const [contestTargetRupees, setContestTargetRupees] = useState(0);
  const [contestDeadline, setContestDeadline] = useState("");
  const [contestMatchId, setContestMatchId] = useState("");
  const [editingMegaId, setEditingMegaId] = useState("");
  const [adminEngine, setAdminEngine] = useState<{
    autoGenerationEnabled: boolean;
    templates: ContestTemplate[];
    contests: AdminContestSummary[];
    generationRuns: { id: string; startedAt: string; status: string; created: number; error?: string | null }[];
  } | null>(null);
  const [adminEngineError, setAdminEngineError] = useState("");
  const [adminEngineBusy, setAdminEngineBusy] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [showMyContests, setShowMyContests] = useState(false);
  const [myContestEntries, setMyContestEntries] = useState<ContestEntry[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [currentTime, setCurrentTime] = useState(INITIAL_TIME);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<"profile" | "settings">("profile");
  const [profileSettingsName, setProfileSettingsName] = useState("");
  const [profileCurrentPassword, setProfileCurrentPassword] = useState("");
  const [profileNewPassword, setProfileNewPassword] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [operationsMode, setOperationsMode] = useState<"admin" | "agent" | null>(null);
  const [showFunds, setShowFunds] = useState(false);
  const canAccessAdmin = authUser?.role === "ADMIN" || authUser?.role === "SUPER_ADMIN";
  const canAccessAgentPanel = authUser?.role === "CASH_AGENT";

  const loadContests = useCallback(async () => {
    if (!authUser) return;
    setContestLoading(true);
    setContestError("");
    try {
      const loadedContests = await requestContests();
      setContests(loadedContests);
    } catch (error) {
      setContestError(error instanceof Error ? error.message : "Could not load contests.");
    } finally {
      setContestLoading(false);
    }
  }, [authUser]);

  const loadAdminEngine = useCallback(async () => {
    if (!canAccessAdmin) return;
    setAdminEngineBusy(true);
    setAdminEngineError("");
    try {
      const response = await fetch("/api/admin/contest-engine");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load contest engine settings.");
      setAdminEngine(data);
    } catch (error) {
      setAdminEngineError(error instanceof Error ? error.message : "Could not load contest engine settings.");
    } finally {
      setAdminEngineBusy(false);
    }
  }, [canAccessAdmin]);

  useEffect(() => {
    let cancelled = false;
    async function fetchCurrentUser() {
      try {
        const response = await fetch("/api/auth/me");
        const data = await readJsonResponse<{ user?: AuthUser; error?: string }>(response, "Sign-in check");
        if (!response.ok) throw new Error(data.error || "Could not check sign-in status.");
        if (!cancelled) {
          setAuthUser(data.user ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : "Could not check sign-in status.");
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    }
    void fetchCurrentUser();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchMatches() {
      try {
        const response = await fetch("/api/matches");
        if (!response.ok) throw new Error("Could not load matches.");
        const data = await response.json();
        if (!cancelled) setMatches(Array.isArray(data) ? data : data.matches ?? []);
      } catch {
        if (!cancelled) {
          setError("Could not connect to the API. Check that port 4000 is running.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchMatches();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authLoading || !authUser || loading || error) return;
    let cancelled = false;
    void requestContests()
      .then((loadedContests) => {
        if (cancelled) return;
        setContests(loadedContests);
        setContestError("");
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setContestError(requestError instanceof Error ? requestError.message : "Could not load contests.");
        }
      })
      .finally(() => {
        if (!cancelled) setContestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, authLoading, loading, error]);

  useEffect(() => {
    if (!authUser || authLoading) return;
    const timer = window.setInterval(() => {
      void requestContests()
        .then((loadedContests) => {
          setContests(loadedContests);
        })
        .catch((refreshError: unknown) => {
          setContestError(refreshError instanceof Error ? refreshError.message : "Could not refresh contests.");
        });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [authUser, authLoading]);

  useEffect(() => {
    if (!canAccessAdmin) return;
    const timer = window.setTimeout(() => void loadAdminEngine(), 0);
    return () => window.clearTimeout(timer);
  }, [canAccessAdmin, loadAdminEngine]);

  useEffect(() => {
    if (!activeMatch || !authUser) return;
    let cancelled = false;
    async function fetchMatchTeams() {
      try {
        const response = await fetch("/api/fantasy-teams");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load your teams.");
        if (!cancelled) setSavedTeams(Array.isArray(data) ? data : data.teams ?? []);
      } catch (loadError) {
        if (!cancelled) {
          setNotice(loadError instanceof Error ? loadError.message : "Could not load your teams.");
        }
      }
    }
    void fetchMatchTeams();
    return () => {
      cancelled = true;
    };
  }, [activeMatch, authUser]);

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const chosenPlayers = useMemo(
    () => players.filter((p) => selected.includes(p.id)),
    [players, selected],
  );
  const creditsUsed = chosenPlayers.reduce((sum, p) => sum + p.creditValue, 0);
  const matchSavedTeams = activeMatch
    ? savedTeams.filter((team) => team.matchId === activeMatch.id)
    : [];
  const nextTeamNumber = Array.from({ length: 25 }, (_, index) => index + 1)
    .find((number) => !matchSavedTeams.some((team) => team.teamNumber === number)) ?? 26;
  const roleCount = (role: string) => chosenPlayers.filter((p) => p.role === role).length;
  const teamCount = (teamId: string) => chosenPlayers.filter((p) => p.cricketTeamId === teamId).length;

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: authEmail,
          password: authPassword,
          ...(authMode === "register" ? { fantasyName: authDisplayName } : {}),
        }),
      });
      const data = await readJsonResponse<{ user?: AuthUser; error?: string }>(response, "Sign in");
      if (!response.ok) throw new Error(data.error || "Could not sign in.");
      if (!data.user) throw new Error("Sign-in response did not include an account. Please try again.");
      setAuthUser(data.user);
      setAuthPassword("");
      setShowAuth(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setAuthBusy(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const data = await readJsonResponse<{ error?: string }>(response, "Sign out");
      if (!response.ok) throw new Error(data.error || "Could not sign out.");
      setAuthUser(null);
      setSavedTeams([]);
      setContests([]);
      setMyContestEntries([]);
      setActiveMatch(null);
      setNotice("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not sign out.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function openBuilder(match: Match) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/matches/${match.id}/players`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load players.");
      const list: Player[] = Array.isArray(data) ? data : data.players ?? [];
      match.playingXIConfirmed = data.playingXIConfirmed ?? match.playingXIConfirmed;
      if (!authUser) {
        setSavedTeams([]);
      }
      setActiveMatch(match);
      setContestMatchId(match.id);
      setContestDeadline(toDateTimeInput(new Date(new Date(match.startsAt).getTime() - 15 * 60_000)));
      setBuilderStep("contests");
      setShowTeamBuilder(false);
      setPlayers(list);
      setSelected([]);
      setCaptain("");
      setViceCaptain("");
      setFilter("ALL");
      setShowSaved(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not load players.");
    } finally {
      setBusy(false);
    }
  }

  function togglePlayer(player: Player) {
    setNotice("");
    if (selected.includes(player.id)) {
      setSelected((old) => old.filter((id) => id !== player.id));
      if (captain === player.id) setCaptain("");
      if (viceCaptain === player.id) setViceCaptain("");
      return;
    }
    if (selected.length >= 11) {
      setNotice("Your team already has 11 players. Remove one before adding another.");
      return;
    }
    if (creditsUsed + player.creditValue > MAX_CREDITS) {
      setNotice("That player would take you over the 100-credit budget.");
      return;
    }
    if (teamCount(player.cricketTeamId) >= 10) {
      setNotice("You can select a maximum of 10 players from one real-world team.");
      return;
    }
    const nextRoleCount = roleCount(player.role) + 1;
    const roleMax: Record<string, number> = {
      WICKETKEEPER: 4, BATTER: 6, ALL_ROUNDER: 4, BOWLER: 6,
    };
    if (nextRoleCount > roleMax[player.role]) {
      setNotice(`Maximum ${roleMax[player.role]} ${roleLabels[player.role]?.toLowerCase() ?? "players"} allowed.`);
      return;
    }
    setSelected((old) => [...old, player.id]);
  }

  async function loadSavedTeams(openModal = true) {
    if (!authUser) {
      setShowAuth(true);
      setAuthError("Sign in to view and manage your teams.");
      return;
    }
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch("/api/fantasy-teams");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load saved teams.");
      setSavedTeams(Array.isArray(data) ? data : data.teams ?? []);
      if (openModal) setShowSaved(true);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not load saved teams.");
    } finally {
      setBusy(false);
    }
  }

  async function prepareSavedTeam(team: SavedTeam, mode: "copy" | "edit") {
    setNotice("");
    setBusy(true);
    try {
      const match = matches.find((item) => item.id === team.matchId);
      if (!match) throw new Error("The match for this team could not be found.");

      const response = await fetch(`/api/matches/${team.matchId}/players`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load players.");
      match.playingXIConfirmed = data.playingXIConfirmed ?? match.playingXIConfirmed;

      setActiveMatch(match);
      setPlayers(Array.isArray(data) ? data : data.players ?? []);
      setSelected((team.selections ?? []).map((selection) => selection.player.id));
      setCaptain(team.captainId ?? "");
      setViceCaptain(team.viceCaptainId ?? "");
      setBuilderStep("team");
      setShowTeamBuilder(true);
      setFilter("ALL");
      setEditingTeamId(mode === "edit" ? team.id : "");
      setShowSaved(false);
      setNotice(mode === "copy"
        ? "Copied lineup loaded. Save it to create a separate team."
        : "Editing team. Save changes when you are ready.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load this team.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTeam() {
    if (!activeMatch) return;
    if (!authUser) {
      setShowAuth(true);
      setAuthError("Sign in or create an account to save your team.");
      return;
    }
    setNotice("");
    if (selected.length !== 11) {
      setNotice(`Select exactly 11 players. You currently have ${selected.length}.`);
      return;
    }
    if (!captain || !viceCaptain) {
      setNotice("Choose a captain and vice-captain.");
      return;
    }
    if (captain === viceCaptain) {
      setNotice("Captain and vice-captain must be different players.");
      return;
    }
    if (roleCount("WICKETKEEPER") < 1 || roleCount("BATTER") < 3 ||
        roleCount("ALL_ROUNDER") < 1 || roleCount("BOWLER") < 3) {
      setNotice("Your XI needs at least 1 wicketkeeper, 3 batters, 1 all-rounder and 3 bowlers.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        editingTeamId ? `/api/fantasy-teams/${editingTeamId}` : "/api/fantasy-teams",
        {
        method: editingTeamId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId: activeMatch.id,
          playerIds: selected,
          captainId: captain,
          viceCaptainId: viceCaptain,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "Could not save team.");
      const successMessage = editingTeamId ? "Team updated successfully!" : `${data.team.name} saved successfully!`;
      setEditingTeamId("");
      const savedTeam = data.team as SavedTeam;
      setSavedTeams((existingTeams) => editingTeamId
        ? existingTeams.map((team) => team.id === savedTeam.id ? savedTeam : team)
        : [...existingTeams, savedTeam]);
      setNotice(successMessage);
      setBuilderStep("team");
      setShowTeamBuilder(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save team.");
    } finally {
      setBusy(false);
    }
  }

  async function loadMyContests(openModal = true) {
    if (!authUser) {
      setShowAuth(true);
      setAuthError("Sign in to view your contest entries.");
      return;
    }
    setContestLoading(true);
    setContestError("");
    try {
      const response = await fetch("/api/my-contests");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load your contests.");
      setMyContestEntries(data.entries ?? []);
      setShowMyContests(openModal);
    } catch (e) {
      setContestError(e instanceof Error ? e.message : "Could not load your contests.");
    } finally {
      setContestLoading(false);
    }
  }

  async function saveProfileSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileError("");
    setProfileNotice("");
    try {
      const response = await fetch("/api/account/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: profileSettingsName,
          ...(profileCurrentPassword ? { currentPassword: profileCurrentPassword } : {}),
          ...(profileNewPassword ? { newPassword: profileNewPassword } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update account settings.");
      setAuthUser(data.user);
      setProfileSettingsName(data.user.displayName);
      setProfileCurrentPassword("");
      setProfileNewPassword("");
      setProfileNotice("Account settings saved.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not update account settings.");
    } finally {
      setProfileBusy(false);
    }
  }

  function applyContestPrizeTemplate(template: "MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM") {
    setContestPrizeTemplate(template);
    const capacity = Math.max(2, Math.floor(Number(contestCapacity) || 2));
    const pool = Math.max(0, Math.floor(capacity * Math.max(0, Number(contestEntryFee) || 0) * (1 - Math.min(10000, Math.max(0, Number(contestCommissionBps) || 0)) / 10000) + Math.max(0, Number(contestSponsorRupees) || 0)));
    const tier = (fromRank: number, toRank: number, fraction: number, winners: number) => ({ fromRank, toRank: Math.min(toRank, capacity), prizeRupees: Math.max(1, Math.floor(pool * fraction / Math.max(1, winners))) });
    let tiers: PrizeTier[];
    if (template === "CUSTOM") tiers = [{ fromRank: 1, toRank: 1, prizeRupees: 100 }];
    else if (template === "HALF_WIN") { const winners = Math.max(1, Math.floor(capacity / 2)); tiers = [tier(1, winners, 0.8, winners)]; }
    else {
      const ranges = template === "MEGA_JACKPOT"
        ? [{ from: 1, to: 1, fraction: 0.35 }, { from: 2, to: 3, fraction: 0.1 }, { from: 4, to: 10, fraction: 0.03 }, { from: 11, to: 20, fraction: 0.01 }]
        : [{ from: 1, to: 1, fraction: 0.08 }, { from: 2, to: 5, fraction: 0.04 }, { from: 6, to: 20, fraction: 0.02 }, { from: 21, to: 50, fraction: 0.005 }];
      tiers = ranges.filter(r => r.from <= capacity).map(r => tier(r.from, Math.min(r.to, capacity), r.fraction, Math.min(r.to, capacity) - r.from + 1));
    }
    setContestFixedPrizeTiers(tiers);
  }

  async function createContest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedMatch = matches.find((match) => match.id === contestMatchId);
    if (!canAccessAdmin || !selectedMatch || !contestMatchId) return;
    setContestLoading(true);
    setContestError("");
    setContestNotice("");
    try {
      const payoutPercentages = contestPayoutText.split(",").map((item) => Number(item.trim()));
      const requestBody = {
        name: contestName.trim(),
        matchId: contestMatchId,
        type: contestType,
        entryFee: Number(contestEntryFee),
        entryFeePaise: String(BigInt(contestEntryFee) * 100n),
        capacity: Number(contestCapacity),
        commissionBps: Number(contestCommissionBps),
        prizePercentages: payoutPercentages,
        prizeMode: contestPrizeMode,
        prizeTemplate: contestPrizeMode === "FIXED" ? contestPrizeTemplate : null,
        fixedPrizeTiers: contestPrizeMode === "FIXED" ? contestFixedPrizeTiers : null,
        sponsorContributionPaise: String(BigInt(contestSponsorRupees) * 100n),
        targetPrizePoolPaise: String(BigInt(contestTargetRupees) * 100n),
        startsAt: selectedMatch.startsAt,
        registrationDeadline: contestDeadline
          ? new Date(contestDeadline).toISOString()
          : new Date(new Date(selectedMatch.startsAt).getTime() - 15 * 60_000).toISOString(),
        publish: true,
      };
      const response = await fetch(
        editingMegaId ? `/api/admin/contests/${editingMegaId}` : "/api/contests",
        {
        method: editingMegaId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save Mega Contest.");
      setContestNotice(data.notice || (editingMegaId ? "Mega Contest updated." : "Mega Contest published."));
      setEditingMegaId("");
      await loadContests();
      await loadAdminEngine();
    } catch (error) {
      setContestError(error instanceof Error ? error.message : "Could not save Mega Contest.");
    } finally {
      setContestLoading(false);
    }
  }

  async function saveContestTemplate(template: ContestTemplate) {
    setAdminEngineBusy(true);
    setAdminEngineError("");
    try {
      const response = await fetch(`/api/admin/contest-templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(template),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the template.");
      await loadAdminEngine();
    } catch (error) {
      setAdminEngineError(error instanceof Error ? error.message : "Could not save the template.");
    } finally {
      setAdminEngineBusy(false);
    }
  }

  function updateContestTemplate(templateId: string, patch: Partial<ContestTemplate>) {
    setAdminEngine((current) => current ? {
      ...current,
      templates: current.templates.map((template) =>
        template.id === templateId ? { ...template, ...patch } : template),
    } : current);
  }

  async function createContestTemplate() {
    if (!newTemplateName.trim()) {
      setAdminEngineError("Enter a name for the new contest template.");
      return;
    }
    setAdminEngineBusy(true);
    setAdminEngineError("");
    try {
      const code = `CUSTOM_${Date.now()}`;
      const response = await fetch("/api/admin/contest-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name: newTemplateName.trim(),
          enabled: false,
          entryFeePaise: "1900",
          capacity: 20,
          contestFormat: "TOP_3",
          commissionBps: 2000,
          payoutPercentages: [50, 30, 20],
          minimumEntriesToOpen: 2,
          registrationLeadMinutes: 15,
          openWindowMinutes: 10080,
          matchEligibility: { matchStatuses: ["UPCOMING"] },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create the template.");
      setNewTemplateName("");
      await loadAdminEngine();
    } catch (error) {
      setAdminEngineError(error instanceof Error ? error.message : "Could not create the template.");
    } finally {
      setAdminEngineBusy(false);
    }
  }

  async function setContestEngineEnabled(enabled: boolean) {
    setAdminEngineBusy(true);
    setAdminEngineError("");
    try {
      const response = await fetch("/api/admin/contest-engine", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoGenerationEnabled: enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update automatic generation.");
      await loadAdminEngine();
    } catch (error) {
      setAdminEngineError(error instanceof Error ? error.message : "Could not update automatic generation.");
    } finally {
      setAdminEngineBusy(false);
    }
  }

  async function manageContest(contestId: string, status: string) {
    setContestLoading(true);
    setContestError("");
    try {
      const response = await fetch(`/api/admin/contests/${contestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update contest status.");
      await loadContests();
      await loadAdminEngine();
    } catch (error) {
      setContestError(error instanceof Error ? error.message : "Could not update contest status.");
    } finally {
      setContestLoading(false);
    }
  }

  function editMegaContest(contest: Contest) {
    setEditingMegaId(contest.id);
    setContestName(contest.name);
    setContestMatchId(contest.matchId);
    setContestType(contest.type);
    setContestEntryFee(contest.entryFee);
    setContestCapacity(contest.capacity);
    setContestCommissionBps(contest.commissionBps ?? 2000);
    setContestPayoutText((contest.prizePercentages ?? [100]).join(","));
    const savedPrizeMode = contest.prizeMode === "FIXED" ? "FIXED" : "PERCENTAGE";
    setContestPrizeMode(savedPrizeMode);
    const savedTemplate = contest.prizeTemplate === "HALF_WIN" || contest.prizeTemplate === "CLIMBER" || contest.prizeTemplate === "CUSTOM" ? contest.prizeTemplate : "MEGA_JACKPOT";
    setContestPrizeTemplate(savedTemplate);
    setContestFixedPrizeTiers(contest.fixedPrizeTiers?.length ? contest.fixedPrizeTiers.map((tier) => ({ ...tier })) : [{ fromRank: 1, toRank: 1, prizeRupees: 100 }]);
    setContestSponsorRupees(Number(BigInt(contest.sponsorContributionPaise ?? "0") / 100n));
    setContestTargetRupees(Number(BigInt(contest.targetPrizePoolPaise ?? "0") / 100n));
    setContestDeadline(toDateTimeInput(contest.registrationDeadline ?? contest.match.startsAt));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function countdown(date: string, now: number) {
    const ms = new Date(date).getTime() - now;
    if (ms <= 0) return "Starting soon";
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return days ? `Starts in ${days}d ${hours}h` : `Starts in ${hours}h ${minutes}m`;
  }

  const filteredPlayers = players.filter((p) => filter === "ALL" || p.role === filter);
  const matchGroups: Record<MatchTab, Match[]> = {
    UPCOMING: matches.filter((match) => match.status.trim().toUpperCase() === "UPCOMING"),
    LIVE: matches.filter((match) => ["LIVE", "IN_PROGRESS", "IN PROGRESS"].includes(match.status.trim().toUpperCase())),
    COMPLETED: matches.filter((match) => ["COMPLETED", "COMPLETE", "FINISHED"].includes(match.status.trim().toUpperCase())),
  };
  const activeMatches = matchGroups[matchTab];

  useEffect(() => {
    if (loading) return;
    if (matchTab === "UPCOMING" && matchGroups.UPCOMING.length === 0 && matchGroups.LIVE.length > 0) {
      setMatchTab("LIVE");
    }
  }, [loading, matchTab, matches]);
  const matchTabLabels: { id: MatchTab; label: string }[] = [
    { id: "UPCOMING", label: "Upcoming" },
    { id: "LIVE", label: "Live" },
    { id: "COMPLETED", label: "Completed" },
  ];
  const matchContests = activeMatch
    ? contests.filter((contest) => contest.matchId === activeMatch.id)
    : [];
  // Keep every admin-created Mega Contest visible, including contests the user joined.
  // Mega Contests are sorted first so the curated section is always at the top.
  const megaContests = matchContests
    .filter((contest) => contest.sourceType === "MEGA")
    .sort((a, b) => {
      const aStart = a.startsAt ? new Date(a.startsAt).getTime() : 0;
      const bStart = b.startsAt ? new Date(b.startsAt).getTime() : 0;
      return aStart - bStart || a.id.localeCompare(b.id);
    });
  const recommendedContests = matchContests
    .filter((contest) => contest.sourceType === "REGULAR" && !contest.joined);
  const joinedContests = matchContests.filter((contest) => contest.joined);
  const myContestGroups = Array.from(
    myContestEntries.reduce((groups, entry) => {
      const group = groups.get(entry.contest.id) ?? { contest: entry.contest, entries: [] as ContestEntry[] };
      group.entries.push(entry);
      groups.set(entry.contest.id, group);
      return groups;
    }, new Map<string, { contest: Contest; entries: ContestEntry[] }>()).values(),
  );
  const contestFormatLabel: Record<Contest["type"], string> = {
    WINNER_TAKES_ALL: "Winner takes all",
    TOP_3: "Top 3",
    TOP_5: "Top 5",
    TOP_10: "Top 10",
    TOP_10_PERCENT: "Top 10%",
    TOP_20_PERCENT: "Top 20%",
    HEAD_TO_HEAD: "Head-to-head",
    THREE_MAX: "3-Max",
    SMALL_FIELD: "Small field",
    MULTI_POSITION: "Multi-position",
  };

  async function joinContest(contest: Contest) {
    const fantasyTeamId = joinTeamSelections[contest.id] || "";
    if (!fantasyTeamId) {
      setContestError("Select one of your saved teams first.");
      return;
    }

    setJoiningContestId(contest.id);
    setContestError("");
    setContestNotice("");

    try {
      const response = await fetch(`/api/contests/${encodeURIComponent(contest.id)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ fantasyTeamId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not join this contest.");
      }

      setContestNotice(`Successfully joined ${contest.name}.`);
      const [updatedContests, updatedEntries] = await Promise.all([
        requestContests(),
        fetch("/api/my-contests", { credentials: "include" }).then(async (r) => {
          if (!r.ok) throw new Error("Joined, but could not refresh your entries.");
          return r.json();
        }),
      ]);

      setContests(updatedContests);
      setMyContestEntries(updatedEntries.entries ?? []);
    } catch (error) {
      setContestError(error instanceof Error ? error.message : "Could not join this contest.");
    } finally {
      setJoiningContestId("");
    }
  }

  const loadContestLeaderboard = async (contestId: string) => {
    if (contestLeaderboard[contestId] || contestLeaderboardLoading[contestId]) return;
    setContestLeaderboardLoading((current) => ({ ...current, [contestId]: true }));
    setContestLeaderboardErrors((current) => ({ ...current, [contestId]: "" }));
    try {
      const response = await fetch(`/api/contests/${encodeURIComponent(contestId)}/leaderboard`);
      const data = await readJsonResponse<ContestLeaderboardResponse & { error?: string }>(
        response,
        "Contest teams",
      );
      if (!response.ok) throw new Error(data.error || "Could not load contest teams.");
      setContestLeaderboard((current) => ({ ...current, [contestId]: data.entries ?? [] }));
      setContestReportEligible((current) => ({ ...current, [contestId]: data.reportEligible === true }));
    } catch (error) {
      setContestLeaderboardErrors((current) => ({
        ...current,
        [contestId]: error instanceof Error ? error.message : "Could not load contest teams.",
      }));
    } finally {
      setContestLeaderboardLoading((current) => ({ ...current, [contestId]: false }));
    }
  };

  const renderContestCards = (items: Contest[]) => items.length === 0
    ? <div className="message">No contests in this section for this match.</div>
    : <div className="match-hub-contests">
      {items.map((contest) => {
        const prizeRows = getPrizeComparisonRows(
          contest.prizeBreakdown,
          contest.maxPrizeBreakdown ?? contest.prizeBreakdown,
        );
        const topPrize = prizeRows.current[0];
        const filledPercent = contest.capacity > 0
          ? Math.min(100, Math.max(0, (contest.entryCount / contest.capacity) * 100))
          : 0;
        const isExpanded = expandedContestId === contest.id;
        const toggleExpanded = () => {
          if (isExpanded) {
            setExpandedContestId("");
            return;
          }
          setExpandedContestId(contest.id);
          setContestDetailTab("leaderboard");
          void loadContestLeaderboard(contest.id);
        };
        return <article
          className={`match-hub-contest wf-clean-contest${contest.joined ? " joined" : ""}${isExpanded ? " is-expanded" : ""}`}
          key={contest.id}
        >
          <button
            type="button"
            className="wf-contest-summary"
            aria-expanded={isExpanded}
            aria-controls={`contest-details-${contest.id}`}
            onClick={toggleExpanded}
          >
            <span
              className={`contest-capacity-track${contest.joined ? " joined" : ""}`}
              role="progressbar"
              aria-label={`${contest.entryCount} of ${contest.capacity} contest spots filled`}
              aria-valuemin={0}
              aria-valuemax={contest.capacity}
              aria-valuenow={Math.min(contest.entryCount, contest.capacity)}
            >
              <span style={{ width: `${filledPercent}%` }} />
            </span>
            <span className="wf-contest-summary-main">
              <strong className="wf-contest-title">{contestFormatLabel[contest.type] || "Fantasy Contest"}</strong>
              <span>{contest.status} · {contest.entryCount}/{contest.capacity} spots filled</span>
              <span>Entry {formatRupees(contest.entryFee)}</span>
            </span>
            <span className="match-hub-prize">
              <span className="wf-prize-label">TOP PRIZE</span>
              <strong>{formatRupees(topPrize?.prizeRupees ?? contest.prizePool)}</strong>
            </span>
            <span className="wf-contest-expand" aria-hidden="true">{isExpanded ? "−" : "+"}</span>
          </button>

          {contest.joined && <span className="contest-joined-label">
            {contest.userEntryCount ?? 1} team{(contest.userEntryCount ?? 1) === 1 ? "" : "s"} entered by you
          </span>}

          {isExpanded && <section className="wf-contest-details" id={`contest-details-${contest.id}`}>
            <div className="wf-contest-tabs" role="tablist" aria-label={`${contest.name} details`}>
              <button
                type="button"
                role="tab"
                aria-selected={contestDetailTab === "leaderboard"}
                className={contestDetailTab === "leaderboard" ? "active" : ""}
                onClick={() => {
                  setContestDetailTab("leaderboard");
                  void loadContestLeaderboard(contest.id);
                }}
              >
                Leaderboard <span>{contest.entryCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={contestDetailTab === "prizes"}
                className={contestDetailTab === "prizes" ? "active" : ""}
                onClick={() => setContestDetailTab("prizes")}
              >
                Prize Breakup
              </button>
            </div>

            {contestDetailTab === "leaderboard" && <div className="wf-contest-tab-panel" role="tabpanel">
              {contestReportEligible[contest.id] && (
                <p>
                  <a
                    href={`/api/contests/${encodeURIComponent(contest.id)}/teams-report`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download Teams Report / Print as PDF
                  </a>
                </p>
              )}
              {contestLeaderboardLoading[contest.id]
                ? <p className="wf-contest-empty">Loading joined teams…</p>
                : contestLeaderboardErrors[contest.id]
                  ? <div className="wf-contest-empty">
                      <p>{contestLeaderboardErrors[contest.id]}</p>
                      <button type="button" onClick={() => {
                        setContestLeaderboard((current) => {
                          const next = { ...current };
                          delete next[contest.id];
                          return next;
                        });
                        void loadContestLeaderboard(contest.id);
                      }}>Try again</button>
                    </div>
                  : (contestLeaderboard[contest.id] ?? []).length === 0
                    ? <p className="wf-contest-empty">No teams have joined this contest yet.</p>
                    : <>
                        <div className="wf-contest-entry-heading">
                          <span>Fantasy team</span><span>Joined</span>
                        </div>
                        {(contestLeaderboard[contest.id] ?? []).map((entry) => (
                          <div className="wf-contest-entry-row" key={entry.id}>
                            <span className="wf-contest-team-identity">
                              <strong>{entry.fantasyName}</strong>
                              <small>{entry.teamName}</small>
                            </span>
                            <time dateTime={entry.joinedAt}>
                              {new Date(entry.joinedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                            </time>
                          </div>
                        ))}
                        <p className="wf-contest-footnote">
                          Teams joined so far. Live points and ranks will appear when scoring is available.
                        </p>
                      </>}
            </div>}

            {contestDetailTab === "prizes" && <div className="wf-contest-tab-panel" role="tabpanel">
              <div className="wf-contest-prize-summary">
                <span>Current prize pool</span>
                <strong>{formatRupees(contest.prizePool)}</strong>
              </div>
              {prizeRows.current.length === 0 && prizeRows.maximum.length === 0
                ? <p className="wf-contest-empty">Prize breakup is not available for this contest yet.</p>
                : <>
                    {prizeRows.current.length > 0 && <>
                      <h4>Current prize breakup · {contest.entryCount} entries</h4>
                      <div className="wf-contest-prize-list">
                        {prizeRows.current.map((row, index) => (
                          <div className="wf-contest-prize-row" key={`current-${row.fromRank}-${row.toRank}-${index}`}>
                            <span>{row.fromRank === row.toRank
                              ? `Rank ${row.fromRank}`
                              : `Rank ${row.fromRank}–${row.toRank}`}</span>
                            <strong>{formatRupees(row.prizeRupees)}</strong>
                          </div>
                        ))}
                      </div>
                    </>}
                    {prizeRows.maximum.length > 0 && <>
                      <h4>Maximum prize breakup · {contest.capacity} entries</h4>
                      <div className="wf-contest-prize-list">
                        {prizeRows.maximum.map((row, index) => (
                          <div className="wf-contest-prize-row" key={`maximum-${row.fromRank}-${row.toRank}-${index}`}>
                            <span>{row.fromRank === row.toRank
                              ? `Rank ${row.fromRank}`
                              : `Rank ${row.fromRank}–${row.toRank}`}</span>
                            <strong>{formatRupees(row.prizeRupees)}</strong>
                          </div>
                        ))}
                      </div>
                    </>}
                  </>}
            </div>}
          </section>}

          {!contest.joined && contest.status === "OPEN" && (
            <div className="contest-join-controls">
              <label>
                Your fantasy team
                <select
                  value={joinTeamSelections[contest.id] ?? ""}
                  onChange={(event) => setJoinTeamSelections((current) => ({
                    ...current,
                    [contest.id]: event.target.value,
                  }))}
                  disabled={joiningContestId === contest.id}
                >
                  <option value="">Select a saved team</option>
                  {savedTeams
                    .filter((team) => team.matchId === contest.matchId)
                    .map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="save-team-button"
                disabled={
                  joiningContestId === contest.id ||
                  !savedTeams.some((team) =>
                    team.matchId === contest.matchId &&
                    team.id === (joinTeamSelections[contest.id] ?? "")
                  ) ||
                  contest.entryCount >= contest.capacity
                }
                onClick={() => {
                  if (window.confirm(
                    `Join ${contest.name} for ${formatRupees(contest.entryFee)}?`
                  )) {
                    void joinContest(contest);
                  }
                }}
              >
                {joiningContestId === contest.id
                  ? "Joining…"
                  : `Join · ${formatRupees(contest.entryFee)}`}
              </button>
            </div>
          )}
          {canAccessAdmin && contest.sourceType !== "REGULAR" &&
            <div className="contest-admin-actions">
              <button className="saved-nav" disabled={contestLoading || !["OPEN", "UPCOMING"].includes(contest.status)} onClick={() => editMegaContest(contest)}>Edit</button>
              {contest.status === "OPEN"
                ? <button className="saved-nav" disabled={contestLoading} onClick={() => void manageContest(contest.id, "CLOSED")}>Close</button>
                : contest.status === "CLOSED"
                  ? <button className="saved-nav" disabled={contestLoading} onClick={() => void manageContest(contest.id, "OPEN")}>Reopen</button>
                  : null}
              {!["CANCELLED", "LIVE", "COMPLETED", "SETTLED"].includes(contest.status) &&
                <button className="saved-nav" disabled={contestLoading} onClick={() => {
                  if (window.confirm("Cancel this contest? This does not process payment refunds.")) {
                    void manageContest(contest.id, "CANCELLED");
                  }
                }}>Cancel contest</button>}
            </div>}
        </article>;
      })}
    </div>;


  if (authLoading) {
    return <main className="auth-gate"><div className="auth-gate-card"><span className="logo">W</span><h1>WillFantasy</h1><p>Checking your sign-in…</p></div></main>;
  }

  if (!authUser) {
    return (
      <main className="auth-gate">
        <form className="auth-gate-card auth-gate-form" onSubmit={(event) => void submitAuth(event)}>
          <a href="#" className="brand auth-gate-brand" aria-label="WillFantasy home"><span className="logo">W</span><span className="brand-name">WillFantasy</span></a>
          <div><span className="eyebrow">FANTASY CRICKET</span><h1>{authMode === "register" ? "Create your account" : "Sign in to play"}</h1><p>Sign in or create an account to access matches, teams, and contests.</p></div>
          {authMode === "register" && <label>Permanent fantasy name<input required maxLength={30} value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} autoComplete="nickname" /><small className="fantasy-name-note">This name cannot be changed after registration.</small></label>}
          <label>Email<input required type="email" maxLength={254} value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} autoComplete="email" /></label>
          <label>Password<input required type="password" minLength={authMode === "register" ? 12 : 1} maxLength={128} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoComplete={authMode === "register" ? "new-password" : "current-password"} /></label>
          {authError && <div className="message error">{authError}</div>}
          <button className="contest-primary" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "register" ? "Create account" : "Sign in"}</button>
          <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); }}>
            {authMode === "register" ? "Already registered? Sign in" : "New to WillFantasy? Create an account"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className={activeMatch ? "app-shell builder-shell" : "app-shell home-shell"}>
      <header className="navbar">
        <div className="header-left">
          <button
            className="profile-trigger"
            onClick={() => {
              setProfileSettingsName(authUser.displayName);
              setProfileError("");
              setProfileNotice("");
              setProfileTab("profile");
              setProfileOpen(true);
            }}
            aria-label="Open player profile"
          >
            <span className="profile-avatar">{authUser.fantasyName.slice(0, 1).toUpperCase()}</span>
            <span className="profile-trigger-name">{authUser.fantasyName}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          <a href="#" className="brand" aria-label="WillFantasy home"><span className="logo">W</span><span className="brand-name">WillFantasy</span></a>
        </div>
        <div className="nav-operations">
          <button className="saved-nav nav-wallet-button" onClick={() => setShowFunds(true)}>Wallet</button>
          {canAccessAdmin && <button className="saved-nav" onClick={() => setOperationsMode("admin")}>Admin console</button>}
          {canAccessAgentPanel && <button className="saved-nav" onClick={() => setOperationsMode("agent")}>Cash agent panel</button>}
        </div>
      </header>

      {operationsMode && <AdminConsole mode={operationsMode} superAdmin={authUser.role === "SUPER_ADMIN"} onClose={() => setOperationsMode(null)} />}
      {showFunds && <FundsPanel onClose={() => setShowFunds(false)} />}

      {showAuth && (
        <div className="saved-overlay" role="dialog" aria-modal="true" aria-label={authMode === "register" ? "Create account" : "Sign in"}>
          <form className="saved-modal auth-modal" onSubmit={(event) => void submitAuth(event)}>
            <div className="saved-modal-head">
              <div><span className="eyebrow">WILLFANTASY ACCOUNT</span><h2>{authMode === "register" ? "Create account" : "Sign in"}</h2></div>
              <button type="button" onClick={() => setShowAuth(false)} aria-label="Close">✕</button>
            </div>
            {authMode === "register" && <label>Permanent fantasy name<input required maxLength={30} value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} autoComplete="nickname" /><small className="fantasy-name-note">This name cannot be changed after registration.</small></label>}
            <label>Email<input required type="email" maxLength={254} value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} autoComplete="email" /></label>
            <label>Password<input required type="password" minLength={authMode === "register" ? 12 : 1} maxLength={128} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} autoComplete={authMode === "register" ? "new-password" : "current-password"} /></label>
            {authError && <div className="message error">{authError}</div>}
            <button className="contest-primary" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "register" ? "Create account" : "Sign in"}</button>
            <button className="auth-mode-toggle" type="button" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); }}>
              {authMode === "register" ? "Already have an account? Sign in" : "New to WillFantasy? Create an account"}
            </button>
          </form>
        </div>
      )}

      {profileOpen && (
        <div className="saved-overlay profile-overlay" role="dialog" aria-modal="true" aria-label="Player profile">
          <section className="saved-modal profile-modal">
            <div className="saved-modal-head">
              <div className="profile-modal-title"><span className="profile-avatar">{authUser.fantasyName.slice(0, 1).toUpperCase()}</span><div><span className="eyebrow">PLAYER ACCOUNT</span><h2>{authUser.fantasyName}</h2></div></div>
              <button onClick={() => setProfileOpen(false)} aria-label="Close player profile">✕</button>
            </div>
            <div className="profile-tabs" role="tablist" aria-label="Profile sections">
              <button type="button" role="tab" aria-selected={profileTab === "profile"} className={profileTab === "profile" ? "profile-tab active" : "profile-tab"} onClick={() => setProfileTab("profile")}>Profile</button>
              <button type="button" role="tab" aria-selected={profileTab === "settings"} className={profileTab === "settings" ? "profile-tab active" : "profile-tab"} onClick={() => { setProfileError(""); setProfileNotice(""); setProfileSettingsName(authUser.displayName); setProfileTab("settings"); }}>Settings</button>
            </div>
            {profileTab === "profile" && <div className="profile-panel">
              <div className="profile-detail"><span>Permanent fantasy name</span><strong>{authUser.fantasyName}</strong></div>
              <div className="profile-detail"><span>Email address</span><strong>{authUser.email}</strong></div>
              <div className="profile-detail"><span>Player ID</span><strong className="profile-id">{authUser.id}</strong></div>
              <div className="profile-menu-actions">
                <button className="saved-nav" onClick={() => { setShowSaved(true); void loadSavedTeams(false); }}>My teams</button>
                <button className="saved-nav" onClick={() => void loadMyContests()}>My contests</button>
                <button className="saved-nav" onClick={() => { setProfileOpen(false); setShowFunds(true); }}>Wallet & payments</button>
                {canAccessAdmin && <button className="saved-nav" onClick={() => { setProfileOpen(false); setOperationsMode("admin"); }}>Admin console</button>}
                {canAccessAgentPanel && <button className="saved-nav" onClick={() => { setProfileOpen(false); setOperationsMode("agent"); }}>Cash agent panel</button>}
                <button className="saved-nav signout-profile" disabled={authBusy} onClick={() => { setProfileOpen(false); void signOut(); }}>{authBusy ? "Please wait…" : "Sign out"}</button>
              </div>
            </div>}
            {profileTab === "settings" && <form className="profile-settings" onSubmit={(event) => void saveProfileSettings(event)}>
              <label>Display name<input required maxLength={50} value={profileSettingsName} onChange={(event) => setProfileSettingsName(event.target.value)} /></label>
              <div className="profile-settings-divider"><span>Password</span><small>Leave both password fields blank to keep your current password.</small></div>
              <label>Current password<input type="password" autoComplete="current-password" value={profileCurrentPassword} onChange={(event) => setProfileCurrentPassword(event.target.value)} /></label>
              <label>New password<input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={profileNewPassword} onChange={(event) => setProfileNewPassword(event.target.value)} /></label>
              {profileError && <div className="message error">{profileError}</div>}
              {profileNotice && <div className="message success">{profileNotice}</div>}
              <button className="contest-primary" type="submit" disabled={profileBusy}>{profileBusy ? "Saving…" : "Save settings"}</button>
            </form>}
          </section>
        </div>
      )}

      {!activeMatch ? (
        <>
          <section className="content home-matches" id="matches">
            <div className="heading">
              <div><span className="eyebrow">MATCH CENTRE</span><h2>{matchTabLabels.find((tab) => tab.id === matchTab)?.label} matches</h2><p>Pick a fixture and create your fantasy team.</p></div>
              <span className="cricket-tab">🏏 &nbsp;Cricket</span>
            </div>
            <div className="match-tabs" role="tablist" aria-label="Filter matches">
              {matchTabLabels.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={matchTab === id}
                  className={matchTab === id ? "match-tab active" : "match-tab"}
                  onClick={() => setMatchTab(id)}
                >
                  {label}<span>{matchGroups[id].length}</span>
                </button>
              ))}
            </div>
            {loading && <div className="message">Loading matches from WillFantasy…</div>}
            {error && <div className="message error">{error}</div>}
            {!loading && !error && activeMatches.length === 0 && <div className="message match-empty">{matchTab === "UPCOMING" ? "No upcoming matches right now." : matchTab === "LIVE" ? "There are no live matches right now." : "No completed matches yet."}</div>}
            <div className="matches">
              {activeMatches.map((match) => {
                const participants = match.participants ?? [];
                const displayTeamName = (team?: { name: string; shortName?: string | null }) => {
                  const shortName = team?.shortName?.trim() ?? "";
                  if (shortName && !/^CLA_[a-f0-9]+$/i.test(shortName)) return shortName;
                  return team?.name?.trim() || "";
                };
                const first = displayTeamName(participants[0]?.cricketTeam) || match.title;
                const second = displayTeamName(participants[1]?.cricketTeam);
                return (
                  <article className="match-card" key={match.id}>
                    <div className="card-top"><span>FANTASY CRICKET</span><span className="status">{match.status}</span></div>
                    {match.playingXIConfirmed && <div style={{ color: "#dc2626", fontWeight: 800, fontSize: "12px", marginTop: "8px" }}>LINEUP ANNOUNCED</div>}
                    <div className="match-card-fixture">
                      <div className="fixture-team"><div className="emblem blue">{first.slice(0, 3).toUpperCase()}</div><strong>{first}</strong></div>
                      <div className="fixture-centre"><span>VS</span><small>{countdown(match.startsAt, currentTime)}</small></div>
                      <div className="fixture-team"><div className="emblem green">{second.slice(0, 3).toUpperCase()}</div><strong>{second}</strong></div>
                    </div>
                    <div className="match-card-actions">
                      <button className="match-create-button" disabled={busy} onClick={() => void openBuilder(match)}>View match <span aria-hidden="true">→</span></button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="notice">ⓘ &nbsp;<span>Contest entry, payments, live scores, and payouts are unavailable while their integrations are being developed.</span></div>
          </section>

        </>
      ) : (
        <section className="builder content">
          <button className="back-button" onClick={() => { setActiveMatch(null); setBuilderStep("contests"); setNotice(""); }}>← Back to matches</button>
          <div className="heading builder-heading">
            <div><span className="eyebrow">MATCH CENTRE</span><h2>{activeMatch.title.split(" — ")[0]}</h2><p>Manage your teams and enter contests for this match.</p></div>
            {builderStep === "team" && showTeamBuilder && <span className="cricket-tab">{selected.length}/11 Players</span>}
          </div>

          <div className="match-detail-tabs" role="tablist" aria-label="Match sections">
            <button type="button" role="tab" aria-selected={builderStep === "contests"} className={builderStep === "contests" ? "match-detail-tab active" : "match-detail-tab"} onClick={() => { setBuilderStep("contests"); setShowTeamBuilder(false); setEditingTeamId(""); }}>Contest</button>
            <button type="button" role="tab" aria-selected={builderStep === "my-contests"} className={builderStep === "my-contests" ? "match-detail-tab active" : "match-detail-tab"} onClick={() => { setBuilderStep("my-contests"); setShowTeamBuilder(false); setEditingTeamId(""); if (authUser) void loadMyContests(false); }}>My Contest</button>
            <button type="button" role="tab" aria-selected={builderStep === "team"} className={builderStep === "team" ? "match-detail-tab active" : "match-detail-tab"} onClick={() => { setBuilderStep("team"); setShowTeamBuilder(false); setEditingTeamId(""); }}>My Team</button>
          </div>

          {builderStep === "contests" && <section className="match-hub">
            <div className="match-hub-heading">
              <div>
                <span className="eyebrow">MATCH CONTESTS</span>
                <h3>Contests</h3>
              </div>
              <span className="match-hub-count">
                {savedTeams.filter((t) => t.matchId === activeMatch.id).length}/25 teams
              </span>
            </div>
            <p className="contest-footnote">Contest entry, payments, live rankings, and payouts are disabled until their integrations are implemented.</p>

            {!authUser && <div className="match-signin-prompt">
              <span>Sign in to view contests and your saved teams for this match.</span>
              <button className="saved-nav" onClick={() => { setAuthError(""); setShowAuth(true); }}>Sign in</button>
            </div>}
            {canAccessAdmin && <section className="admin-engine-panel">
              <div className="admin-engine-heading">
                <div><span className="eyebrow">ADMIN CONTEST ENGINE</span><h3>Automatic contests & templates</h3><p>Regular contests run on the API worker; they do not depend on an open browser.</p></div>
                <div className="admin-engine-controls">
                  <button className="saved-nav" disabled={adminEngineBusy} onClick={() => void setContestEngineEnabled(!adminEngine?.autoGenerationEnabled)}>{adminEngine?.autoGenerationEnabled ? "Pause generation" : "Enable generation"}</button>
                  <button className="saved-nav" disabled={adminEngineBusy} onClick={async () => {
                    setAdminEngineBusy(true);
                    setAdminEngineError("");
                    try {
                      const response = await fetch("/api/admin/contest-engine/run", { method: "POST" });
                      const data = await response.json();
                      if (!response.ok) throw new Error(data.error || "Could not run generation.");
                      await loadAdminEngine();
                    } catch (error) {
                      setAdminEngineError(error instanceof Error ? error.message : "Could not run generation.");
                    } finally {
                      setAdminEngineBusy(false);
                    }
                  }}>Run generation now</button>
                </div>
              </div>
              <p className="contest-footnote">
                Automatic generation: <b>{adminEngine?.autoGenerationEnabled ? "Enabled" : "Paused"}</b>. Entry and payout processing are unavailable until payment and scoring integrations are implemented.
              </p>
              {adminEngineError && <div className="message error">{adminEngineError}</div>}
              {adminEngineBusy && <div className="message">Updating contest engine…</div>}
              <div className="admin-template-list">
                {(adminEngine?.templates ?? []).map((template) => <article className="admin-template-card" key={template.id}>
                  <div className="admin-template-title"><strong>{template.name}</strong><span>{template.code}</span></div>
                  <div className="admin-template-fields">
                    <label>Name<input value={template.name} onChange={(event) => updateContestTemplate(template.id, { name: event.target.value })} /></label>
                    <label>Entry fee (paise)<input type="number" min="0" value={template.entryFeePaise} onChange={(event) => updateContestTemplate(template.id, { entryFeePaise: event.target.value })} /></label>
                    <label>Slots<input type="number" min="2" value={template.capacity} onChange={(event) => updateContestTemplate(template.id, { capacity: Number(event.target.value) })} /></label>
                    <label>Format<select value={template.contestFormat} onChange={(event) => updateContestTemplate(template.id, { contestFormat: event.target.value as Contest["type"] })}>
                      {Object.entries(contestFormatLabel).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
                    </select></label>
                    <label>Commission (bps)<input type="number" min="0" max="10000" value={template.commissionBps} onChange={(event) => updateContestTemplate(template.id, { commissionBps: Number(event.target.value) })} /></label>
                    <label>Payout percentages<input value={template.payoutPercentages.join(",")} onChange={(event) => updateContestTemplate(template.id, { payoutPercentages: event.target.value.split(",").map((part) => Number(part.trim())).filter(Number.isFinite) })} /></label>
                    <label>Minimum entries to proceed<input type="number" min="1" value={template.minimumEntriesToOpen} onChange={(event) => updateContestTemplate(template.id, { minimumEntriesToOpen: Number(event.target.value) })} /><small>Below this at cutoff: cancel and refund entries.</small></label>
                    <label>Open window (minutes)<input type="number" min="1" value={template.openWindowMinutes} onChange={(event) => updateContestTemplate(template.id, { openWindowMinutes: Number(event.target.value) })} /></label>
                    <label>Registration lead (minutes)<input type="number" min="1" value={template.registrationLeadMinutes} onChange={(event) => updateContestTemplate(template.id, { registrationLeadMinutes: Number(event.target.value) })} /></label>
                    <label>Eligible match statuses<select multiple size={3}
                      value={Array.isArray(template.matchEligibility.matchStatuses)
                        ? template.matchEligibility.matchStatuses.filter((status): status is string => typeof status === "string")
                        : ["UPCOMING"]}
                      onChange={(event) => updateContestTemplate(template.id, {
                        matchEligibility: {
                          ...template.matchEligibility,
                          matchStatuses: Array.from(event.target.selectedOptions, (option) => option.value),
                        },
                      })}>
                      <option value="UPCOMING">Upcoming</option>
                      <option value="LIVE">Live</option>
                      <option value="COMPLETED">Completed</option>
                    </select></label>
                  </div>
                  <label className="admin-template-enabled"><input type="checkbox" checked={template.enabled} onChange={(event) => updateContestTemplate(template.id, { enabled: event.target.checked })} /> Enable template</label>
                  <button className="saved-nav" disabled={adminEngineBusy} onClick={() => void saveContestTemplate(template)}>Save template</button>
                </article>)}
              </div>
              <form className="admin-template-new" onSubmit={(event) => { event.preventDefault(); void createContestTemplate(); }}>
                <label>New template name<input required value={newTemplateName} onChange={(event) => setNewTemplateName(event.target.value)} /></label>
                <button className="saved-nav" disabled={adminEngineBusy}>Create disabled template</button>
              </form>
              <div className="admin-run-history">
                <strong>Recent generation runs</strong>
                {(adminEngine?.generationRuns ?? []).length === 0
                  ? <span>No generation runs recorded.</span>
                  : adminEngine?.generationRuns.map((run) => <span key={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.status} · {run.created} contests{run.error ? ` · ${run.error}` : ""}</span>)}
              </div>
              <div className="admin-run-history">
                <strong>Contest occupancy & finance (paise)</strong>
                {(adminEngine?.contests ?? []).slice(0, 20).map((item) => <span key={item.id}>
                  {item.name} · {item.match.title} · {item.entryCount}/{item.capacity} · {item.status} · pool {formatPaise(item.prizePoolPaise)} · gross {formatPaise(item.grossRevenuePaise)} · commission {formatPaise(item.commissionPaise)} · sponsor {formatPaise(item.sponsorContributionPaise)} · liability {formatPaise(item.prizeLiabilityPaise)} · {item.payoutStatus}
                </span>)}
              </div>
            </section>}
            {canAccessAdmin && <form className="admin-contest-form" onSubmit={(event) => void createContest(event)}>
              <div><span className="eyebrow">MEGA CONTESTS · ADMIN CREATED ONLY</span><h3>{editingMegaId ? "Edit Mega Contest" : "Create Mega Contest"}</h3></div>
              <label>Contest name<input required maxLength={80} value={contestName} onChange={(event) => setContestName(event.target.value)} /></label>
              <div className="admin-contest-fields">
                <label>Match<select required value={contestMatchId} onChange={(event) => {
                  const match = matches.find((item) => item.id === event.target.value);
                  setContestMatchId(event.target.value);
                  if (match) {
                                  setContestDeadline(toDateTimeInput(new Date(new Date(match.startsAt).getTime() - 15 * 60_000)));
                  }
                }}>{matches.map((match) => <option key={match.id} value={match.id}>{match.title}</option>)}</select></label>
                <label>Format<select value={contestType} onChange={(event) => setContestType(event.target.value as Contest["type"])}>{Object.entries(contestFormatLabel).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
                <label>Entry fee (₹)<input type="number" min="0" max="2147483647" step="1" required value={contestEntryFee} onChange={(event) => setContestEntryFee(Number(event.target.value))} /></label>
                <label>Capacity (teams)<input type="number" min="2" max="2147483647" step="1" required value={contestCapacity} onChange={(event) => setContestCapacity(Number(event.target.value))} /></label>
                <label>Commission (basis points)<input type="number" min="0" max="10000" step="1" required value={contestCommissionBps} onChange={(event) => setContestCommissionBps(Number(event.target.value))} /></label>
                <label>Prize payout mode<select value={contestPrizeMode} onChange={(event) => setContestPrizeMode(event.target.value as "PERCENTAGE" | "FIXED")}><option value="PERCENTAGE">Percentage payout</option><option value="FIXED">Fixed rupee prizes</option></select></label>
                {contestPrizeMode === "PERCENTAGE" && <label>Payout percentages (sum 100)<input required value={contestPayoutText} onChange={(event) => setContestPayoutText(event.target.value)} /></label>}
                {contestPrizeMode === "FIXED" && <>
                  <label>Prize template<select value={contestPrizeTemplate} onChange={(event) => applyContestPrizeTemplate(event.target.value as "MEGA_JACKPOT" | "HALF_WIN" | "CLIMBER" | "CUSTOM")}><option value="MEGA_JACKPOT">Mega Jackpot — top-heavy</option><option value="HALF_WIN">Half-Win Challenge — about half win</option><option value="CLIMBER">The Climber — balanced tiers</option><option value="CUSTOM">Custom — define your own</option></select></label>
                  <div className="fixed-prize-editor">
                    <strong>Prize tiers (₹ per winning entry)</strong>
                    {contestFixedPrizeTiers.map((tier, index) => <div className="admin-contest-fields fixed-prize-tier" key={`${index}-${tier.fromRank}-${tier.toRank}`}>
                      <label>From rank<input type="number" min="1" max={contestCapacity} required value={tier.fromRank} onChange={(event) => setContestFixedPrizeTiers((current) => current.map((item, i) => i === index ? { ...item, fromRank: Number(event.target.value) } : item))} /></label>
                      <label>To rank<input type="number" min="1" max={contestCapacity} required value={tier.toRank} onChange={(event) => setContestFixedPrizeTiers((current) => current.map((item, i) => i === index ? { ...item, toRank: Number(event.target.value) } : item))} /></label>
                      <label>Prize per rank (₹)<input type="number" min="1" step="1" required value={tier.prizeRupees} onChange={(event) => setContestFixedPrizeTiers((current) => current.map((item, i) => i === index ? { ...item, prizeRupees: Number(event.target.value) } : item))} /></label>
                      <button className="saved-nav" type="button" disabled={contestFixedPrizeTiers.length <= 1} onClick={() => setContestFixedPrizeTiers((current) => current.filter((_, i) => i !== index))}>Remove</button>
                    </div>)}
                    <button className="saved-nav" type="button" disabled={contestFixedPrizeTiers.length >= 100 || contestFixedPrizeTiers.every((tier) => tier.toRank >= Number(contestCapacity))} onClick={() => setContestFixedPrizeTiers((current) => { const next = Math.max(0, ...current.map((tier) => tier.toRank)) + 1; return [...current, { fromRank: Math.min(Number(contestCapacity), next), toRank: Math.min(Number(contestCapacity), next), prizeRupees: 100 }]; })}>Add prize tier</button>
                    <p className="contest-footnote">Winning ranks: {contestFixedPrizeTiers.reduce((sum, tier) => sum + Math.max(0, Math.floor(tier.toRank) - Math.floor(tier.fromRank) + 1), 0)} · Estimated maximum liability: ₹{contestFixedPrizeTiers.reduce((sum, tier) => sum + Math.max(0, Math.floor(tier.toRank) - Math.floor(tier.fromRank) + 1) * Math.max(0, Number(tier.prizeRupees) || 0), 0).toLocaleString("en-IN")} · Estimated available at capacity: ₹{Math.floor(Math.max(0, Number(contestCapacity) || 0) * Math.max(0, Number(contestEntryFee) || 0) * (1 - Math.min(10000, Math.max(0, Number(contestCommissionBps) || 0)) / 10000) + Math.max(0, Number(contestSponsorRupees) || 0)).toLocaleString("en-IN")}</p>
                  </div>
                </>}
                <label>Registration deadline<input type="datetime-local" required value={contestDeadline} onChange={(event) => setContestDeadline(event.target.value)} /></label>
                <label>Target prize pool (₹)<input type="number" min="0" step="1" value={contestTargetRupees} onChange={(event) => setContestTargetRupees(Number(event.target.value))} /></label>
                <label>Sponsor contribution (₹)<input type="number" min="0" step="1" value={contestSponsorRupees} onChange={(event) => setContestSponsorRupees(Number(event.target.value))} /></label>
              </div>
              <p className="contest-footnote">Contest entry and payout processing remain unavailable until payment and live scoring integrations are implemented. Financial values are projections only.</p>
              <div className="contest-admin-actions">
                <button className="contest-primary" type="submit" disabled={contestLoading || !matches.length}>{contestLoading ? "Saving…" : editingMegaId ? "Save Mega Contest" : "Publish Mega Contest"}</button>
                {editingMegaId && <button className="saved-nav" type="button" onClick={() => setEditingMegaId("")}>Stop editing</button>}
              </div>
            </form>}
            {contestError && <div className="message error">{contestError}</div>}
            {contestNotice && <div className="message success">{contestNotice}</div>}
            {contestLoading && <div className="message">Loading contests…</div>}
            {authUser && megaContests.length > 0 && (
              <div className="contest-lobby-section mega-contests-pinned">
                <div><span className="eyebrow">ADMIN CURATED</span><h3>Mega Contests</h3></div>
                {renderContestCards(megaContests)}
              </div>
            )}
            {authUser && recommendedContests.length > 0 && (
              <div className="contest-lobby-section">
                <div><span className="eyebrow">SYSTEM GENERATED</span><h3>Recommended Contests</h3></div>
                {renderContestCards(recommendedContests)}
              </div>
            )}
          </section>}

          {builderStep === "my-contests" && <section className="match-hub match-hub-teams">
            <div className="match-hub-heading">
              <div><span className="eyebrow">YOUR ENTRIES</span><h3>My Contest</h3></div>
              <span className="match-hub-count">{joinedContests.length} joined</span>
            </div>
            {!authUser
              ? <div className="message">Sign in to view your contests.</div>
              : myContestGroups.filter(({ contest }) => contest.matchId === activeMatch.id).length === 0
                ? <div className="message">You have not joined a contest for this match yet.</div>
                : <div className="match-hub-saved">
                    {myContestGroups.filter(({ contest }) => contest.matchId === activeMatch.id).map(({ contest, entries }) => (
                      <article className="saved-team-card" key={contest.id}>
                        <strong>{contest.name}</strong>
                        <span>Teams: {entries.map((entry) => entry.fantasyTeam.name).join(", ")}</span>
                        <span>{entries.length} entries · {contest.entryCount}/{contest.capacity} total</span>
                      </article>
                    ))}
                  </div>}
          </section>}

          {builderStep === "team" && !showTeamBuilder && <>
          <section className="match-hub match-hub-teams">
            <div className="match-hub-heading">
              <div><span className="eyebrow">YOUR LINEUPS</span><h3>My Teams</h3><p>Teams are numbered automatically for this match. Create a team to choose players.</p></div>
              <span className="match-hub-count">{matchSavedTeams.length}/25 teams</span>
            </div>
            {authUser && <button className="saved-nav" onClick={() => void loadSavedTeams(false)}>Refresh teams</button>}
            {!authUser
              ? <div className="message">Sign in to save and manage teams.</div>
              : matchSavedTeams.length === 0
                ? <div className="message">No teams created for this match yet.</div>
                : <div className="match-hub-saved">
                    {matchSavedTeams.map((team) =>
                      <article className="saved-team-card" key={team.id}>
                        <strong>{team.name}</strong>
                        <span>{team.selections?.length ?? 0} players saved</span>
                        <span>{team.selections?.filter((selection) => selection.player.id === team.captainId).map((selection) => selection.player.name).join("") || "Captain not set"} (C)</span>
                        <span>{team.selections?.filter((selection) => selection.player.id === team.viceCaptainId).map((selection) => selection.player.name).join("") || "Vice-captain not set"} (VC)</span>
                        <div className="saved-team-actions">
                          <button className="saved-nav" onClick={() => void prepareSavedTeam(team, "edit")}>Edit</button>
                          <button className="saved-nav" disabled={matchSavedTeams.length >= 25} onClick={() => void prepareSavedTeam(team, "copy")}>Copy</button>
                        </div>
                      </article>
                    )}
                  </div>}
          </section>
          {authUser && matchSavedTeams.length < 25 &&
            <button className="contest-primary flow-new-team" onClick={() => {
              setSelected([]);
              setCaptain("");
              setViceCaptain("");
              setEditingTeamId("");
              setShowTeamBuilder(true);
              setNotice(players.length < 11
                ? `Only ${players.length} players are available. Add player data before building a complete XI.`
                : "");
            }}>
            + Create Team {nextTeamNumber}
            </button>}
          </>}

          {builderStep === "team" && showTeamBuilder && <>
          <button className="back-button" onClick={() => { setShowTeamBuilder(false); setEditingTeamId(""); setNotice(""); }}>← Back to My Teams</button>
          <div className="team-builder-title">
            <span className="eyebrow">{editingTeamId ? "EDIT YOUR TEAM" : "BUILD YOUR TEAM"}</span>
            <h3>{editingTeamId ? "Edit lineup" : `Create ${nextTeamNumber <= 25 ? `Team ${nextTeamNumber}` : "team"}`}</h3>
            <p>Select your 11 players and choose a captain and vice-captain.</p>
          </div>
          {activeMatch.playingXIConfirmed && (() => {
            const unavailable = players.filter((p) => selected.includes(p.id) && p.isPlayingXI === false);
            return unavailable.length ? <div className="message error"><strong>Playing XI warning: {unavailable.length} selected player{unavailable.length === 1 ? "" : "s"} not in the confirmed XI.</strong><p>{unavailable.map((p) => p.name).join(", ")}</p>Remove these players and select confirmed playing-XI players before the match starts.</div> : null;
          })()}
          <div className="team-summary">
            <div><span>Players</span><strong>{selected.length} <small>/ 11</small></strong></div>
            <div><span>Credits used</span><strong>{creditsUsed.toFixed(1)} <small>/ 100</small></strong></div>
            <div><span>Credits left</span><strong>{(MAX_CREDITS - creditsUsed).toFixed(1)}</strong></div>
          </div>
          <div className="credit-track"><span style={{ width: `${Math.min(creditsUsed, 100)}%` }} /></div>

          <div className="role-filters">
            {Object.entries(roleLabels).map(([key, label]) => (
              <button key={key} className={filter === key ? "filter active" : "filter"} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>

          <div className="player-list">
            {filteredPlayers.map((player) => {
              const isSelected = selected.includes(player.id);
              return (
                <article key={player.id} className={isSelected ? "player-row player-selected" : "player-row"}>
                  <div className="player-avatar">{player.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()}</div>
                  <div className="player-info"><strong>{player.name}</strong><span>{player.cricketTeam.shortName} · {roleLabels[player.role] || player.role}</span></div>
                  <div className="player-credit"><strong>{player.creditValue}</strong><span>credits</span></div>
                  <button className={isSelected ? "pick-button picked" : "pick-button"} onClick={() => togglePlayer(player)}>{isSelected ? "✓ Added" : "+ Add"}</button>
                </article>
              );
            })}
            {filteredPlayers.length === 0 && <div className="message">No players available for this filter.</div>}
          </div>

          <div className="role-summary">
            <span>WK <b>{roleCount("WICKETKEEPER")}</b></span>
            <span>BAT <b>{roleCount("BATTER")}</b></span>
            <span>AR <b>{roleCount("ALL_ROUNDER")}</b></span>
            <span>BOWL <b>{roleCount("BOWLER")}</b></span>
          </div>

          <div className="captain-panel">
            <span className="eyebrow">TEAM LEADERS</span>
            <h3>Choose captain & vice-captain</h3>
            <p>Captain earns 2× points and vice-captain earns 1.5× points.</p>
            <label>Captain (C)
              <select value={captain} onChange={(e) => setCaptain(e.target.value)}>
                <option value="">Choose captain</option>
                {chosenPlayers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>Vice-captain (VC)
              <select value={viceCaptain} onChange={(e) => setViceCaptain(e.target.value)}>
                <option value="">Choose vice-captain</option>
                {chosenPlayers.filter((p) => p.id !== captain).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          {notice && <div className={notice.toLowerCase().includes("success") ? "message success" : "message error"}>{notice}</div>}
          <button className="save-team-button" disabled={busy || selected.length !== 11 || (!editingTeamId && savedTeams.filter((team) => team.matchId === activeMatch.id).length >= 25)} onClick={() => void saveTeam()}>
            {busy ? "Please wait…" : `${editingTeamId ? "Update" : "Save"} ${editingTeamId ? "team" : `Team ${nextTeamNumber}`} (${selected.length}/11)`}
          </button>
          <p className="builder-footnote">Contest entry is unavailable until payment and live scoring integrations are implemented.</p>
          </>}
        </section>
      )}

      {showMyContests && (
        <div className="saved-overlay" role="dialog" aria-modal="true" aria-label="My Contests">
          <section className="saved-modal">
            <div className="saved-modal-head"><div><span className="eyebrow">YOUR ENTRIES</span><h2>My Contests</h2></div><button onClick={() => setShowMyContests(false)}>✕</button></div>
            {myContestGroups.length === 0
              ? <div className="message">You have not joined any contests yet.</div>
              : myContestGroups.map(({ contest, entries }) =>
                <article className="saved-team-card" key={contest.id}>
                  <strong>{contest.name}</strong>
                  <span>{contest.match?.title}</span>
                  <span>Your teams: {entries.map((entry) => entry.fantasyTeam.name).join(", ")}</span>
                  <span>{entries.length} entries · {contest.entryCount}/{contest.capacity} total</span>
                </article>
              )}
          </section>
        </div>
      )}

      {showSaved && (
        <div className="saved-overlay" role="dialog" aria-modal="true" aria-label="My saved teams">
          <section className="saved-modal">
            <div className="saved-modal-head"><div><span className="eyebrow">YOUR LINEUPS</span><h2>My Teams</h2></div><button onClick={() => setShowSaved(false)} aria-label="Close">✕</button></div>
            {savedTeams.length === 0 ? <div className="message">No saved teams yet. Create your first XI!</div> : savedTeams.map((team) => (
              <article className="saved-team-card" key={team.id}>
                <strong>{team.name}</strong>
                <span>{team.selections?.length ?? 0} players saved</span>
                {activeMatch?.id === team.matchId && activeMatch.playingXIConfirmed && (() => {
                  const unavailable = (team.selections ?? []).filter((s) => s.player.isPlayingXI === false);
                  return unavailable.length ? <div className="message error"><strong>{unavailable.length} player{unavailable.length === 1 ? "" : "s"} not in the confirmed XI</strong><p>{unavailable.map((s) => s.player.name).join(", ")}</p></div> : null;
                })()}
                {team.selections?.length ? <p>{team.selections.map((s) => `${s.player.name}${s.player.id === team.captainId ? " (C)" : s.player.id === team.viceCaptainId ? " (VC)" : ""}`).join(", ")}</p> : null}
                <div className="team-actions">
                  <button type="button" onClick={() => void prepareSavedTeam(team, "copy")}>Copy</button>
                  <button type="button" onClick={() => void prepareSavedTeam(team, "edit")}>Edit</button>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}


      <footer><a href="#" className="brand"><span className="logo">W</span> will<span className="muted">fantasy</span></a><span>Built for the love of cricket.</span><span>In development</span></footer>
    </main>
  );
}
