import type { City } from "@maxmind/geoip2-node";
import { Reader } from "@maxmind/geoip2-node";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { IS_CLOUD } from "../../lib/const.js";
import { logger } from "../../lib/logger/logger.js";
import { IPAPIResponse, LocationResponse } from "./types.js";

// Adjust path to find the database relative to project root
const dbPath = path.join(process.cwd(), "GeoLite2-City.mmdb");

let reader: Reader | null = null;

// Extend the Reader type to include the city method
interface ExtendedReader extends Reader {
  city(ip: string): City;
}

async function loadDatabase(dbPath: string) {
  const dbBuffer = await readFile(dbPath);
  reader = Reader.openBuffer(dbBuffer);
  logger.info("GeoIP database loaded successfully");
}

await loadDatabase(dbPath);

// IP2Location integration for ISP/Domain/UsageType enrichment
let ip2location: any = null;

const ip2lBinPath = process.env.IP2LOCATION_BIN_PATH || path.join(process.cwd(), "IP2LOCATION.BIN");

if (existsSync(ip2lBinPath)) {
  try {
    const { IP2Location } = await import("ip2location-nodejs");
    ip2location = new IP2Location();
    ip2location.open(ip2lBinPath);
    logger.info(`IP2Location database loaded successfully from ${ip2lBinPath}`);
  } catch (e) {
    logger.warn(`Failed to load IP2Location database: ${e}`);
  }
} else {
  logger.info("IP2Location BIN file not found, ISP/ASN enrichment disabled. Set IP2LOCATION_BIN_PATH env var or place IP2LOCATION.BIN in server root.");
}

// Map IP2Location usageType to Rybbit's asn_type categories
function mapUsageType(usageType: string): string {
  if (!usageType || usageType === "?" || usageType === "-") return "";
  const ut = usageType.toUpperCase();
  // IP2Location usage types: ISP, COM, ORG, GOV, MIL, EDU, LIB, CDN, DCH, SES, MOB, ISP/MOB, RSV
  if (ut.includes("ISP") || ut.includes("MOB")) return "isp";
  if (ut === "DCH" || ut === "CDN" || ut === "SES") return "hosting";
  if (ut === "COM" || ut === "ORG") return "business";
  if (ut === "GOV" || ut === "MIL") return "government";
  if (ut === "EDU" || ut === "LIB") return "education";
  return ut.toLowerCase();
}

// Utility function to extract response data
function extractLocationData(response: City | null): LocationResponse {
  if (!response) {
    return null;
  }

  return {
    city: response.city?.names?.en,
    country: response.country?.names?.en,
    countryIso: response.country?.isoCode,
    latitude: response.location?.latitude,
    longitude: response.location?.longitude,
    timeZone: response.location?.timeZone,
    region: response.subdivisions?.[0]?.isoCode,
  };
}

const apiKey = process.env.IPAPI_KEY;

// Cache configuration
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run cleanup every hour

interface CacheEntry {
  data: LocationResponse;
  timestamp: number;
}

// In-memory cache for IP geolocation data
const ipCache = new Map<string, CacheEntry>();

// Periodic cleanup function to remove expired entries
function cleanupExpiredEntries(): void {
  const now = Date.now();
  let removedCount = 0;

  for (const [ip, entry] of ipCache.entries()) {
    const age = now - entry.timestamp;
    if (age > CACHE_TTL_MS) {
      ipCache.delete(ip);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    logger.info(`Cleaned up ${removedCount} expired IP cache entries. Current cache size: ${ipCache.size}`);
  }
}

// Start periodic cleanup
const cleanupInterval = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);

// Cleanup on process exit
process.on("SIGTERM", () => {
  clearInterval(cleanupInterval);
});
process.on("SIGINT", () => {
  clearInterval(cleanupInterval);
});

function getCachedIP(ip: string): LocationResponse | null {
  const entry = ipCache.get(ip);
  if (!entry) {
    return null;
  }

  const now = Date.now();
  const age = now - entry.timestamp;

  if (age > CACHE_TTL_MS) {
    // Entry expired, remove it
    ipCache.delete(ip);
    return null;
  }

  return entry.data;
}

function setCachedIP(ip: string, data: LocationResponse): void {
  ipCache.set(ip, {
    data,
    timestamp: Date.now(),
  });
}

async function getLocationFromIPAPI(ips: string[]): Promise<Record<string, LocationResponse>> {
  if (!apiKey) {
    logger.warn("IPAPI_KEY not configured for cloud geolocation");
    return {};
  }

  // Check cache first
  const results: Record<string, LocationResponse> = {};
  const uncachedIps: string[] = [];

  for (const ip of ips) {
    const cached = getCachedIP(ip);
    if (cached !== null) {
      results[ip] = cached;
    } else {
      uncachedIps.push(ip);
    }
  }

  // If all IPs were cached, return immediately
  if (uncachedIps.length === 0) {
    return results;
  }

  // logger.info(`Cache hit: ${ips.length - uncachedIps.length}/${ips.length}, fetching ${uncachedIps.length} from IPAPI`);

  const localInfo = await getLocationFromLocal(uncachedIps);

  // IPAPI has a limit of 100 IPs per request, so we need to batch them
  const BATCH_SIZE = 100;
  const batches: string[][] = [];

  for (let i = 0; i < uncachedIps.length; i += BATCH_SIZE) {
    batches.push(uncachedIps.slice(i, i + BATCH_SIZE));
  }

  try {
    // Process batches sequentially to avoid rate limiting
    for (const batch of batches) {
      const response = await fetch("https://api.ipapi.is/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ips: batch,
          key: apiKey,
        }),
      });

      if (!response.ok) {
        logger.error(
          `IPAPI request failed for batch of ${batch.length} IPs: ${response.status} ${response.statusText}`
        );
        continue; // Skip this batch but continue with others
      }

      const data = (await response.json()) as Record<string, IPAPIResponse>;

      for (const ip of batch) {
        const item = data[ip];

        if (!item) {
          continue;
        }

        const localInfo = await (reader as ExtendedReader).city(ip);
        const locationData: LocationResponse = {
          ...extractLocationData(localInfo),
          vpn: item.vpn?.service,
          crawler: typeof item.is_crawler === "string" ? item.is_crawler : undefined,
          datacenter: item.datacenter?.datacenter,
          isProxy: item.is_proxy,
          isTor: item.is_tor,
          isSatellite: item.is_satellite,

          company: {
            name: item.company?.name,
            domain: item.company?.domain,
            type: item.company?.type,
            abuseScore: Number(item.company?.abuser_score?.split(" ")[0]),
          },

          asn: {
            asn: item.asn?.asn,
            org: item.asn?.org,
            domain: item.asn?.domain,
            type: item.asn?.type,
            abuseScore: Number(item.asn?.abuser_score?.split(" ")[0]),
          },
        };

        // Cache the result
        setCachedIP(ip, locationData);
        results[ip] = locationData;
      }
    }

    return results;
  } catch (error) {
    logger.error(error, "Error fetching from IPAPI");
    return { ...results, ...localInfo };
  }
}

async function getLocationFromLocal(ips: string[]): Promise<Record<string, LocationResponse>> {
  const responses = await Promise.all(
    ips.map(ip => {
      try {
        return (reader as ExtendedReader).city(ip);
      } catch (error) {
        return null;
      }
    })
  );

  const results: Record<string, LocationResponse> = {};

  responses.forEach((response, index) => {
    const ip = ips[index];
    const base = extractLocationData(response);

    // Enrich with IP2Location ISP/Domain/UsageType data
    if (ip2location && base) {
      try {
        const ip2lResult = ip2location.getAll(ip);

        const isp = ip2lResult.isp && ip2lResult.isp !== "?" ? ip2lResult.isp : "";
        const domain = ip2lResult.domain && ip2lResult.domain !== "?" ? ip2lResult.domain : "";
        const usageType = ip2lResult.usageType && ip2lResult.usageType !== "?" ? ip2lResult.usageType : "";
        const mappedType = mapUsageType(usageType);

        base.company = {
          name: isp,
          domain: domain,
          type: mappedType,
        };

        base.asn = {
          asn: undefined,
          org: isp,
          domain: domain,
          type: mappedType,
        };

        // Mark datacenter traffic
        if (usageType.toUpperCase() === "DCH") {
          base.datacenter = isp || "unknown";
        }
      } catch (e) {
        // IP2Location lookup failed for this IP, skip enrichment
      }
    }

    results[ip] = base;
  });

  return results;
}

export async function getLocation(ips: string[], useLocal?: boolean): Promise<Record<string, LocationResponse>> {
  const dedupedIps = [...new Set(ips)];

  if (IS_CLOUD && !useLocal) {
    return getLocationFromIPAPI(dedupedIps);
  }

  return getLocationFromLocal(dedupedIps);
}
