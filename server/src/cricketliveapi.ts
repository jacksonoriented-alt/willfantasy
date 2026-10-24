import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

const optionalString = z.string().nullable().optional();
const providerId = z.union([
  z.string().trim().min(1),
  z.number().int().safe(),
]).transform(String);

const providerTeamSchema = z.object({
  id: providerId,
  name: optionalString,
  full_name: optionalString,
  image_id: z.union([z.string(), z.number().int().safe()]).nullable().optional(),
  team_image_url: optionalString,
}).passthrough().superRefine((team, context) => {
  if (!team.name?.trim() && !team.full_name?.trim()) {
    context.addIssue({
      code: "custom",
      message: "A team must include a name or full_name.",
    });
  }
});

const providerMatchSchema = z.object({
  match_id: providerId,
  series_id: providerId.nullable().optional(),
  series_name: optionalString,
  match_desc: optionalString,
  title: optionalString,
  format: optionalString,
  match_type: optionalString,
  date: z.string().min(1),
  end_date: optionalString,
  venue: optionalString,
  venue_timezone: optionalString,
  venue_id: providerId.nullable().optional(),
  status_detail: optionalString,
  short_status: optionalString,
  state: optionalString,
  status: optionalString,
  is_time_announced: z.boolean().nullable().optional(),
  slug: optionalString,
  first_team: providerTeamSchema,
  second_team: providerTeamSchema,
  fantasy_status: optionalString,
  fantasy_eligible: z.boolean().nullable().optional(),
}).passthrough().superRefine((match, context) => {
  if (match.first_team.id === match.second_team.id) {
    context.addIssue({
      code: "custom",
      path: ["second_team", "id"],
      message: "A match must have two different teams.",
    });
  }
});

const matchesResponseSchema = z.object({
  success: z.literal(true),
  type: z.string(),
  count: z.number().int().nonnegative(),
  data: z.array(providerMatchSchema),
}).superRefine((response, context) => {
  const ids = new Set<string>();
  response.data.forEach((match, index) => {
    if (ids.has(match.match_id)) {
      context.addIssue({
        code: "custom",
        path: ["data", index, "match_id"],
        message: "A response cannot contain duplicate match IDs.",
      });
    }
    ids.add(match.match_id);
  });
});

export class CricketLiveApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CricketLiveApiContractError";
  }
}

export type CricketLiveApiMatch = z.infer<typeof providerMatchSchema>;

export function parseProviderDate(value: string, referenceYear?: number): Date {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);

  if (iso) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = iso;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText ?? 0);
    const minute = Number(minuteText ?? 0);
    const second = Number(secondText ?? 0);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
        hour > 23 || minute > 59 || second > 59) {
      throw new CricketLiveApiContractError("A match date contains an invalid calendar or time value.");
    }
    if (offset && offset !== "Z") {
      const offsetHours = Number(offset.slice(1, 3));
      const offsetMinutes = Number(offset.slice(4, 6));
      if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
        throw new CricketLiveApiContractError("A match date contains an invalid timezone offset.");
      }
    }

    const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(parsed.getTime())) {
      throw new CricketLiveApiContractError("A match date could not be parsed.");
    }
    return parsed;
  }

  const providerDate = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{2}):(\d{2})\s+GMT$/.exec(value);
  if (providerDate) {
    if (!referenceYear || !Number.isInteger(referenceYear) || referenceYear < 1970) {
      throw new CricketLiveApiContractError("The provider date omits the year and no reliable match year was found.");
    }

    const [, monthText, dayText, hourText, minuteText] = providerDate;
    const months: Record<string, number> = {
      Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
      Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
    };
    if (!monthText || !(monthText in months)) {
      throw new Error(`Invalid month in provider date: ${value}`);
    }
    const month = months[monthText];
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const daysInMonth = month ? new Date(Date.UTC(referenceYear, month, 0)).getUTCDate() : 0;

    if (!month || day < 1 || day > daysInMonth || hour > 23 || minute > 59) {
      throw new CricketLiveApiContractError("The provider date contains an invalid calendar or time value.");
    }
    return new Date(Date.UTC(referenceYear, month - 1, day, hour, minute));
  }

  throw new CricketLiveApiContractError("A match date must be ISO-formatted or a provider GMT date with a known match year.");
}
export function parseCricketLiveApiMatches(value: unknown): CricketLiveApiMatch[] {
  const result = matchesResponseSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) {
      throw new CricketLiveApiContractError("Invalid CricketLiveAPI matches response.");
    }
    const location = issue.path.length ? issue.path.join(".") : "response";
    throw new CricketLiveApiContractError(`Invalid CricketLiveAPI matches response at ${location}: ${issue.message}`);
  }
  for (const [index, match] of result.data.data.entries()) {
    for (const field of ["date", "end_date"] as const) {
      const dateValue = match[field];
      if (!dateValue) continue;
      try {
        const yearText = `${match.series_name ?? ""} ${match.title ?? ""}`.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
        const referenceYear = yearText ? Number(yearText[1]) : new Date().getUTCFullYear();
        parseProviderDate(dateValue, referenceYear);
      } catch (error) {
        if (error instanceof CricketLiveApiContractError) {
          throw new CricketLiveApiContractError(`Invalid CricketLiveAPI matches response at data.${index}.${field}: ${error.message}`);
        }
        throw error;
      }
    }
  }
  return result.data.data;
}

export function getMatchStatus(match: CricketLiveApiMatch): string {
  const allStatuses = [match.state, match.status, match.short_status, match.status_detail]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (/postpon/.test(allStatuses)) return "POSTPONED";
  if (/cancel/.test(allStatuses)) return "CANCELLED";
  if (/abandon|no result/.test(allStatuses)) return "ABANDONED";
  if (/complete|finished|result declared|match over/.test(allStatuses)) return "COMPLETED";
  if (/live|in progress|innings break|stumps|day [1-5]|lunch|tea break/.test(allStatuses)) return "LIVE";

  return "UPCOMING";
}

export function resolveMatchStatusTransition(currentStatus: string, incomingStatus: string): string {
  const current = currentStatus.toUpperCase();
  const incoming = incomingStatus.toUpperCase();

  // Do not regress a completed match because the provider returned stale data.
  if (current === "COMPLETED" && ["UPCOMING", "LIVE"].includes(incoming)) {
    return current;
  }

  // A live match should not revert to upcoming because of stale data.
  if (current === "LIVE" && incoming === "UPCOMING") {
    return current;
  }

  return incoming;
}

function getTeamName(team: CricketLiveApiMatch["first_team"]): string {
  const name = team.full_name?.trim() || team.name?.trim();
  if (!name) throw new CricketLiveApiContractError("A provider team is missing its name.");
  return name;
}

export function providerTeamShortName(teamId: string): string {
  const digest = createHash("sha256").update(teamId).digest("hex").slice(0, 16);
  return `CLA_${digest}`;
}

export async function importCricketLiveApiMatches(
  tx: Prisma.TransactionClient,
  matches: CricketLiveApiMatch[],
  syncedAt = new Date(),
) {
  let created = 0;
  let updated = 0;

  for (const fixture of matches) {
    const firstTeam = fixture.first_team;
    const secondTeam = fixture.second_team;
    const firstTeamShortName = providerTeamShortName(firstTeam.id);
    const secondTeamShortName = providerTeamShortName(secondTeam.id);
    const firstTeamDisplayName = getTeamName(firstTeam);
    const secondTeamDisplayName = getTeamName(secondTeam);
    const yearText = `${fixture.series_name ?? ""} ${fixture.title ?? ""}`.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
    const startsAt = parseProviderDate(fixture.date, yearText ? Number(yearText[1]) : undefined);
    const title = fixture.title?.trim() ||
      fixture.match_desc?.trim() ||
      `${getTeamName(firstTeam)} vs ${getTeamName(secondTeam)}`;
    const incomingStatus = getMatchStatus(fixture);
    const teams = await Promise.all([
      tx.cricketTeam.upsert({
        where: { shortName: firstTeamShortName },
        create: { name: firstTeamDisplayName, shortName: firstTeamDisplayName },
        update: { name: firstTeamDisplayName, shortName: firstTeamDisplayName },
        select: { id: true },
      }),
      tx.cricketTeam.upsert({
        where: { shortName: secondTeamShortName },
        create: { name: secondTeamDisplayName, shortName: secondTeamDisplayName },
        update: { name: secondTeamDisplayName, shortName: secondTeamDisplayName },
        select: { id: true },
      }),
    ]);

    const existing = await tx.match.findUnique({
      where: {
        provider_externalFixtureId: {
          provider: "CRICKETLIVEAPI",
          externalFixtureId: fixture.match_id,
        },
      },
      select: { id: true, status: true },
    });
    const status = existing
      ? resolveMatchStatusTransition(existing.status, incomingStatus)
      : incomingStatus;

    const match = await tx.match.upsert({
      where: {
        provider_externalFixtureId: {
          provider: "CRICKETLIVEAPI",
          externalFixtureId: fixture.match_id,
        },
      },
      create: {
        title,
        startsAt,
        status,
        provider: "CRICKETLIVEAPI",
        externalFixtureId: fixture.match_id,
        competition: fixture.series_name?.trim() || null,
        format: fixture.format?.trim() || fixture.match_type?.trim() || null,
        isEnabled: false,
        dataStatus: "INCOMPLETE",
        lastSyncedAt: syncedAt,
      },
      update: {
        title,
        startsAt,
        status,
        ...(["CANCELLED", "ABANDONED", "POSTPONED"].includes(status)
          ? { dataStatus: "INCOMPLETE" as const }
          : {}),
        competition: fixture.series_name?.trim() || null,
        format: fixture.format?.trim() || fixture.match_type?.trim() || null,
        lastSyncedAt: syncedAt,
        syncError: null,
      },
      select: { id: true },
    });
    await tx.matchParticipant.deleteMany({ where: { matchId: match.id } });
    await tx.matchParticipant.createMany({
      data: teams.map(({ id: cricketTeamId }) => ({ matchId: match.id, cricketTeamId })),
    });

    created += Number(!existing);
    updated += Number(Boolean(existing));
  }

  return { received: matches.length, created, updated, syncedAt: syncedAt.toISOString() };
}

export async function fetchCricketLiveApiMatches(apiKey: string): Promise<CricketLiveApiMatch[]> {
  const response = await fetch("https://cricketliveapi.com/api/v1/fantasy/matches", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`CricketLiveAPI matches request failed with HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CricketLiveApiContractError("CricketLiveAPI returned a response that was not valid JSON.");
  }
  return parseCricketLiveApiMatches(payload);
}
