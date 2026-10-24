import assert from "node:assert/strict";
import test from "node:test";
import {
  CricketLiveApiContractError,
  getMatchStatus,
  resolveMatchStatusTransition,
  parseCricketLiveApiMatches,
  parseProviderDate,
  providerTeamShortName,
} from "./cricketliveapi";

function response(matchOverrides: Record<string, unknown> = {}, firstTeamOverrides: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    type: "matches",
    count: 1,
    data: [{
      match_id: 42,
      series_id: 7,
      series_name: "Test Series",
      match_desc: "First Test",
      title: "Team A vs Team B",
      format: "TEST",
      match_type: "International",
      date: "2026-10-17T15:30:00+05:30",
      end_date: "2026-10-19",
      venue: "Example Ground",
      venue_timezone: "Asia/Kolkata",
      venue_id: 9,
      status_detail: "Scheduled",
      short_status: "Upcoming",
      state: "Upcoming",
      status: "Match not started",
      is_time_announced: true,
      slug: "team-a-vs-team-b",
      first_team: { id: 10, name: "A", full_name: "Team A", image_id: 100, team_image_url: "https://example.test/a.png", ...firstTeamOverrides },
      second_team: { id: 11, name: "B", full_name: "Team B" },
      fantasy_status: "Available",
      fantasy_eligible: true,
      ...matchOverrides,
    }],
  };
}

test("validates documented match fields and normalizes provider identifiers", () => {
  const [match] = parseCricketLiveApiMatches(response());
  assert.ok(match);
  assert.equal(match.match_id, "42");
  assert.equal(match.series_id, "7");
  assert.equal(match.first_team.id, "10");
  assert.equal(match.first_team.full_name, "Team A");
});

test("parses date-only values as UTC and timezone timestamps as their instant", () => {
  assert.equal(parseProviderDate("2026-10-17").toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(parseProviderDate("2026-10-17T15:30:00+05:30").toISOString(), "2026-10-17T10:00:00.000Z");
});

test("rejects malformed and timezone-ambiguous match dates", () => {
  for (const date of ["2026-02-30", "2026-10-17T15:30:00", "17/10/2026", "2026-10-17T15:30:00+14:30"]) {
    assert.throws(() => parseProviderDate(date), CricketLiveApiContractError);
  }
});

test("rejects invalid optional fields and missing team names", () => {
  assert.throws(
    () => parseCricketLiveApiMatches(response({ fantasy_eligible: "yes" })),
    /data\.0\.fantasy_eligible/,
  );
  assert.throws(
    () => parseCricketLiveApiMatches(response({}, { name: null, full_name: " " })),
    /name or full_name/,
  );
});

test("rejects duplicate provider match identifiers in a sync response", () => {
  const payload = response() as { count: number; data: unknown[] };
  payload.data.push({ ...payload.data[0] as object });
  payload.count = 2;
  assert.throws(() => parseCricketLiveApiMatches(payload), /duplicate match IDs/);
});

test("derives stable, provider-scoped team keys without exposing provider IDs", () => {
  assert.equal(providerTeamShortName("10"), providerTeamShortName("10"));
  assert.notEqual(providerTeamShortName("10"), providerTeamShortName("11"));
  assert.match(providerTeamShortName("10"), /^CLA_[a-f0-9]{16}$/);
});

test("normalizes postponed and abandoned fixture states so roster readiness can reject them", () => {
  const [upcoming] = parseCricketLiveApiMatches(response());
  assert.ok(upcoming);
  assert.equal(getMatchStatus({ ...upcoming, state: "Upcoming", status: "Postponed" }), "POSTPONED");
  assert.equal(getMatchStatus({ ...upcoming, state: "Abandoned" }), "ABANDONED");
});
test("recognizes live and completed provider statuses across status fields", () => {
  const [upcoming] = parseCricketLiveApiMatches(response());
  assert.ok(upcoming);

  assert.equal(getMatchStatus({ ...upcoming, state: "Upcoming", status: "Live" }), "LIVE");
  assert.equal(getMatchStatus({ ...upcoming, state: "In Progress" }), "LIVE");
  assert.equal(getMatchStatus({ ...upcoming, status_detail: "Innings Break" }), "LIVE");
  assert.equal(getMatchStatus({ ...upcoming, state: "Upcoming", status: "Match Finished" }), "COMPLETED");
  assert.equal(getMatchStatus({ ...upcoming, state: "Completed" }), "COMPLETED");
  assert.equal(getMatchStatus({ ...upcoming, state: "Upcoming", status: "Postponed" }), "POSTPONED");
});

test("prevents stale provider statuses from regressing live or completed matches", () => {
  assert.equal(resolveMatchStatusTransition("COMPLETED", "UPCOMING"), "COMPLETED");
  assert.equal(resolveMatchStatusTransition("COMPLETED", "LIVE"), "COMPLETED");
  assert.equal(resolveMatchStatusTransition("LIVE", "UPCOMING"), "LIVE");
  assert.equal(resolveMatchStatusTransition("UPCOMING", "LIVE"), "LIVE");
  assert.equal(resolveMatchStatusTransition("LIVE", "COMPLETED"), "COMPLETED");
  assert.equal(resolveMatchStatusTransition("UPCOMING", "POSTPONED"), "POSTPONED");
});
