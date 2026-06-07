/*
 * health-controller.v5-ewma.js
 *
 * EWMA (Exponentially Weighted Moving Average) for latency baseline
 * - Adaptive baseline that gradually adjusts to new normal
 * - Reduces false positives from transient spikes
 * - Combined with practical significance thresholds
 * - Maintains historical variance for z-score calculation
 *
 * Added: MAX_ACTIVE_AGE_MS - rotate active region after this age even without anomaly
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const dns = require('dns/promises');

// ===== CONFIG =====
const INTERVAL_MS = 5000;
const EDS_DIR = '/etc/envoy/eds';
const CLUSTERS = [
  { name: 'app_http', port: 80 },
  { name: 'app_https', port: 443 }
];

const REGIONS = [
  { id: 'E', host: 'lb.e.ehealth.id', healthPort: 80 },
  { id: 'F', host: 'lb.f.ehealth.id', healthPort: 80 }
];

const SHORT_WINDOW_SAMPLES = 12;
const LONG_WINDOW_SAMPLES = 120;
const PROBE_TIMEOUT_MS = 2000;

const FAIL_RATIO_THRESHOLD = 2.5;
const ABS_FAIL_RATE_THRESHOLD = 0.30;
const SWITCHING_SIGMA_THRESHOLD = 2.0;
const CONSECUTIVE_FAIL_THRESHOLD = 3;

// EWMA config
const EWMA_ALPHA = 0.030;                  // Smoothing factor (0.05-0.2 typical, lower = more smoothing)
const EWMA_VARIANCE_ALPHA = 0.015;         // Slower adaptation for variance
const MIN_EWMA_SAMPLES = 20;               // Minimum samples before trusting EWMA

// Latency anomaly detection with EWMA
const LATENCY_Z_THRESHOLD = 2.5;           // Statistical significance
const LATENCY_ABS_THRESHOLD = 10;          // Absolute: 10ms minimum difference
const LATENCY_REL_THRESHOLD = 0.20;        // Relative: 20% increase
const MIN_LATENCY_STDDEV = 3;              // Minimum variance floor

const ABS_LATENCY_THRESHOLD = 1000;
const MIN_LONG_SAMPLES_FOR_BASELINE = 30;

// Hysteresis
const BASE_CONFIRM_COUNT = 3;
const COOLDOWN_MS = 20000;

// Flap suppression
const FLAP_WINDOW_MS = 60 * 1000;
const FLAP_THRESHOLD = 3;
const FLAP_CONFIRM_INCREMENT = 2;

// Max active age: rotate even without anomaly (24h)
const MAX_ACTIVE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ===== STATE =====
class SlidingWindow {
  constructor(maxSize) { this.maxSize = maxSize; this.arr = []; }
  push(v) { this.arr.push(v); if (this.arr.length > this.maxSize) this.arr.shift(); }
  values() { return this.arr.slice(); }
  size() { return this.arr.length; }
  clear() { this.arr = []; }
}

class RegionState {
  constructor(region) {
    this.region = region;
    this.shortWin = new SlidingWindow(SHORT_WINDOW_SAMPLES);
    this.longWin = new SlidingWindow(LONG_WINDOW_SAMPLES);
    this.lastDecision = null;

    // EWMA state for latency baseline
    this.ewmaLatency = null;              // Exponentially weighted mean
    this.ewmaVariance = null;             // Exponentially weighted variance
    this.ewmaSampleCount = 0;             // Track maturity
  }

  updateEWMA(latency) {
    if (latency === null || latency === undefined) return;

    if (this.ewmaLatency === null) {
      // Initialize on first sample
      this.ewmaLatency = latency;
      this.ewmaVariance = 0;
      this.ewmaSampleCount = 1;
    } else {
      // Update mean: EWMA = α * new + (1-α) * old
      const prevMean = this.ewmaLatency;
      this.ewmaLatency = EWMA_ALPHA * latency + (1 - EWMA_ALPHA) * this.ewmaLatency;

      // Update variance: Var = α * (x - mean)² + (1-α) * old_var
      const delta = latency - prevMean;
      const delta2 = latency - this.ewmaLatency;
      this.ewmaVariance = EWMA_VARIANCE_ALPHA * (delta * delta2) + (1 - EWMA_VARIANCE_ALPHA) * (this.ewmaVariance || 0);

      this.ewmaSampleCount++;
    }
  }

  getEWMAStddev() {
    if (this.ewmaVariance === null || this.ewmaVariance <= 0) return 0;
    return Math.sqrt(this.ewmaVariance);
  }

  hasMaturedEWMA() {
    return this.ewmaSampleCount >= MIN_EWMA_SAMPLES;
  }
}

const regionsState = REGIONS.map(r => new RegionState(r));

let lastActiveRegionId = null;
let lastFlipTime = 0;
let flipHistory = [];

let pendingCandidateId = null;
let pendingConfirmCount = 0;

function now() { return Date.now(); }

function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${level}: ${msg} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`);
}

async function httpProbe(region) {
  return new Promise((resolve) => {
    const start = now();
    const options = { host: region.host, port: region.healthPort, path: '/healthz', timeout: PROBE_TIMEOUT_MS };
    const req = http.get(options, (res) => {
      const latency = now() - start;
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.on('data', () => {});
      res.on('end', () => resolve({ ok, statusCode: res.statusCode, latency }));
    });
    req.on('error', (err) => resolve({ ok: false, statusCode: 0, latency: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: 0, latency: null }); });
  });
}

function mean(arr){ if (!arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function variance(arr, arrMean = null){ if (!arr.length) return 0; const m = arrMean === null ? mean(arr) : arrMean; return arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length; }
function stddev(arr, arrMean = null){ return Math.sqrt(variance(arr, arrMean)); }

function analyzeWindow(regionState) {
  const short = regionState.shortWin.values();
  const long = regionState.longWin.values();

  const shortFails = short.filter(s => !s.ok).length;
  const longFails = long.filter(s => !s.ok).length;
  const shortFailRate = short.length ? shortFails / short.length : 0;
  const longFailRate = long.length ? longFails / long.length : 0;

  const shortFailSE = short.length > 1 ? Math.sqrt(shortFailRate * (1 - shortFailRate) / short.length) : Infinity;
  const longFailSE = long.length > 1 ? Math.sqrt(longFailRate * (1 - longFailRate) / long.length) : Infinity;

  let maxConsecutiveFails = 0, cur = 0;
  for (const s of short) { if (!s.ok) { cur++; maxConsecutiveFails = Math.max(maxConsecutiveFails, cur); } else cur = 0; }

  const shortLat = short.filter(s=>s.ok && s.latency!=null).map(s=>s.latency);
  const longLat = long.filter(s=>s.ok && s.latency!=null).map(s=>s.latency);
  const shortLatMean = mean(shortLat);
  const longLatMean = mean(longLat);
  const shortLatStd = stddev(shortLat, shortLatMean);
  const longLatStd = stddev(longLat, longLatMean);

  // Get EWMA baseline (use longLatMean as fallback)
  const ewmaLatency = regionState.ewmaLatency;
  const ewmaStddev = regionState.getEWMAStddev();
  const hasMaturedEWMA = regionState.hasMaturedEWMA();
  const ewmaSamples = regionState.ewmaSampleCount;

  // Choose baseline: prefer EWMA if matured, otherwise use long window
  const baselineLatency = hasMaturedEWMA ? ewmaLatency : longLatMean;
  const baselineStddev = hasMaturedEWMA ? ewmaStddev : longLatStd;

  // Apply minimum variance floor to prevent hypersensitivity
  const adjustedShortStd = Math.max(shortLatStd, MIN_LATENCY_STDDEV);
  const adjustedBaselineStd = Math.max(baselineStddev, MIN_LATENCY_STDDEV);

  const shortN = shortLat.length;
  const longN = longLat.length;

  // SE calculation: short window stddev vs baseline stddev
  const latSe = (shortN > 0) ?
    Math.sqrt((adjustedShortStd*adjustedShortStd)/(shortN||1) + (adjustedBaselineStd*adjustedBaselineStd)/(hasMaturedEWMA ? ewmaSamples : longN)) :
    Infinity;

  return {
    shortFailRate, longFailRate, shortFailSE, longFailSE,
    maxConsecutiveFails, shortCount: short.length, longCount: long.length,
    shortLatMean, longLatMean, shortLatStd, longLatStd,
    baselineLatency,      // EWMA or longLatMean
    baselineStddev,       // EWMA stddev or longLatStd
    ewmaLatency,          // Raw EWMA value
    ewmaStddev,           // Raw EWMA stddev
    hasMaturedEWMA,       // EWMA is trustworthy
    ewmaSamples,          // EWMA sample count
    latSe,                // Standard error for z-score
    shortLatCount: shortN,
    longLatCount: longN
  };
}

function isAnomalous(regionState) {
  const a = analyzeWindow(regionState);
  const reasons = [];
  const haveBaseline = a.longCount >= MIN_LONG_SAMPLES_FOR_BASELINE;

  let failAnom = false;
  if (a.maxConsecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
    failAnom = true;
    reasons.push({ type: 'CONSECUTIVE_FAILURES', message: `${a.maxConsecutiveFails} consecutive failures` });
  }

  if (haveBaseline && a.longFailRate >= 0.05) {
    const ratio = a.shortFailRate / (a.longFailRate || 1e-9);
    if (ratio >= FAIL_RATIO_THRESHOLD) {
      failAnom = true;
      reasons.push({ type:'FAILURE_RATIO', message:`short ${ratio.toFixed(2)}x baseline` });
    }
  }

  if (a.shortFailRate >= ABS_FAIL_RATE_THRESHOLD) {
    failAnom = true;
    reasons.push({ type:'ABSOLUTE_FAILURE', message: 'short fail rate high' });
  }

  // ==== EWMA-BASED LATENCY ANOMALY DETECTION ====
  let latencyAnom = false;

  // Require mature baseline (either EWMA or long window)
  const hasLatencyBaseline = a.hasMaturedEWMA || (haveBaseline && a.longLatCount > MIN_EWMA_SAMPLES);

  if (hasLatencyBaseline && a.shortLatCount >= 3 && isFinite(a.latSe) && a.latSe > 0) {
    // Compare short window mean to EWMA baseline
    const z = (a.shortLatMean - a.baselineLatency) / a.latSe;
    const absDiff = a.shortLatMean - a.baselineLatency;
    const relDiff = a.baselineLatency > 0 ? absDiff / a.baselineLatency : 0;

    // Statistical significance
    const statSig = z >= LATENCY_Z_THRESHOLD;

    // Practical significance: require EITHER absolute OR relative threshold
    const practSig = (absDiff >= LATENCY_ABS_THRESHOLD) || (relDiff >= LATENCY_REL_THRESHOLD);

    // Trigger only if BOTH conditions met
    if (statSig && practSig) {
      latencyAnom = true;
      reasons.push({
        type:'LATENCY_SPIKE',
        message: `z=${z.toFixed(2)}, Δ=${absDiff.toFixed(0)}ms (${(relDiff*100).toFixed(0)}%)`,
        shortMean: Math.round(a.shortLatMean),
        baselineMean: Math.round(a.baselineLatency),
        baselineType: a.hasMaturedEWMA ? 'EWMA' : 'LONG',
        ewmaSamples: a.ewmaSamples
      });
    }
  } else if (!hasLatencyBaseline && a.shortLatCount >= 3) {
    // Add info about immature baseline
    reasons.push({
      type:'IMMATURE_LATENCY_BASELINE',
      message: `EWMA: ${a.ewmaSamples}/${MIN_EWMA_SAMPLES}, Long: ${a.longLatCount}/${MIN_LONG_SAMPLES_FOR_BASELINE}`
    });
  }

  if (a.shortLatMean >= ABS_LATENCY_THRESHOLD && a.shortLatCount >= 3) {
    latencyAnom = true;
    reasons.push({ type:'ABSOLUTE_LATENCY', message:'mean latency high' });
  }

  if (!haveBaseline) {
    reasons.push({ type:'INSUFFICIENT_BASELINE', message:`${a.longCount}/${MIN_LONG_SAMPLES_FOR_BASELINE}` });
  }

  const anomalous = failAnom || latencyAnom;

  return {
    anomalous,
    failAnom,
    latencyAnom,
    haveBaseline,
    hasLatencyBaseline,
    reasons: reasons.length ? reasons : [{ type:'HEALTHY', message:'ok' }],
    summary: {
      shortFailRate: a.shortFailRate,
      shortLatMean: a.shortLatMean,
      longFailRate: a.longFailRate,
      longLatMean: a.longLatMean,
      baselineLatency: a.baselineLatency,
      ewmaLatency: a.ewmaLatency,
      hasMaturedEWMA: a.hasMaturedEWMA,
      ewmaSamples: a.ewmaSamples
    }
  };
}

function decideActiveRegion() {
  const evaluations = regionsState.map(rs => ({
    regionState: rs,
    analysis: analyzeWindow(rs),
    anomaly: isAnomalous(rs)
  }));

  if (lastActiveRegionId) {
    const currentEval = evaluations.find(e => e.regionState.region.id === lastActiveRegionId);
    if (currentEval && currentEval.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.8) {
      const currentFailRate = currentEval.analysis.shortFailRate;
      const currentGood = !currentEval.anomaly.anomalous && currentFailRate < 0.4 && currentEval.anomaly.haveBaseline;

      if (currentGood) {
        const alternatives = evaluations.filter(e =>
          e.regionState.region.id !== lastActiveRegionId &&
          !e.anomaly.anomalous &&
          e.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.8 &&
          e.anomaly.haveBaseline
        );

        for (const alt of alternatives) {
          const altFailRate = alt.analysis.shortFailRate;
          const improvement = currentFailRate - altFailRate;
          if (improvement <= 0) continue;

          const seDiff = Math.sqrt(
            Math.pow(currentEval.analysis.shortFailSE, 2) +
            Math.pow(alt.analysis.shortFailSE, 2)
          );
          const isSignificant = seDiff > 0 ?
            (improvement / seDiff) >= SWITCHING_SIGMA_THRESHOLD :
            improvement > 0.05;

          if (isSignificant) {
            const currentLat = currentEval.analysis.shortLatMean;
            const altLat = alt.analysis.shortLatMean;

            if (alt.analysis.shortLatCount >= 3 && currentEval.analysis.shortLatCount >= 3) {
              if (altLat <= currentLat + Math.max(10, currentLat * 0.2)) {
                log('INFO', 'Statistically significant candidate found', {
                  current: lastActiveRegionId,
                  candidate: alt.regionState.region.id,
                  improvement,
                  z: (improvement/seDiff).toFixed(2)
                });
                return alt;
              }
            } else {
              log('DEBUG', 'Skipping candidate due to immature latency samples', {
                candidate: alt.regionState.region.id
              });
            }
          }
        }
        return currentEval;
      }
    }
  }

  const healthyCandidates = evaluations.filter(e =>
    !e.anomaly.anomalous &&
    e.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.8 &&
    e.analysis.shortFailRate < 0.4 &&
    e.anomaly.haveBaseline
  );

  if (healthyCandidates.length) {
    healthyCandidates.sort((a,b) => a.analysis.shortFailRate - b.analysis.shortFailRate);
    return healthyCandidates[0];
  }

  const fallback = evaluations.filter(e => e.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.6);
  if (fallback.length) {
    fallback.sort((a,b)=>a.analysis.shortFailRate-b.analysis.shortFailRate);
    return fallback[0];
  }

  return evaluations[0];
}

async function resolveHost(host) {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.map(a=>a.address);
  } catch (err) {
    log('ERROR', `DNS lookup failed for ${host}`, { err: err.message });
    return [];
  }
}

function renderEDS(clusterName, regionIp, port) {
  return {
    resources: [
      {
        "@type": "type.googleapis.com/envoy.config.endpoint.v3.ClusterLoadAssignment",
        cluster_name: clusterName,
        endpoints: [
          {
            lb_endpoints: [
              {
                endpoint: {
                  address: {
                    socket_address: {
                      address: regionIp,
                      port_value: port
                    }
                  }
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function writeAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function countRecentFlips() {
  const cutoff = now() - FLAP_WINDOW_MS;
  flipHistory = flipHistory.filter(t => t >= cutoff);
  return flipHistory.length;
}

// MAIN LOOP
async function probeAllOnce() {
  for (const rs of regionsState) {
    try {
      const res = await httpProbe(rs.region);
      rs.shortWin.push(res);
      rs.longWin.push(res);

      // Update EWMA on successful probes
      if (res.ok && res.latency !== null) {
        rs.updateEWMA(res.latency);
      }
    } catch (err) {
      rs.shortWin.push({ ok:false, statusCode:0, latency:null });
      rs.longWin.push({ ok:false, statusCode:0, latency:null });
    }
  }

  // Default decision from normal logic
  const decision = decideActiveRegion();
  if (!decision) { log('ERROR','no decision'); return; }

  const nowTs = now();
  let candidateId = decision.regionState.region.id;
  let candidateDecision = decision; // may be overridden below if we force rotation
  let forceRotate = false;

  // Age-based rotation: if active region older than MAX_ACTIVE_AGE_MS, prefer rotating
  const ageExpired = lastActiveRegionId && (nowTs - lastFlipTime >= MAX_ACTIVE_AGE_MS);
  if (ageExpired) {
    log('INFO', 'Active region age exceeded threshold, attempting rotation', { lastActiveRegionId, ageMs: nowTs - lastFlipTime });

    // Build local evaluations to pick the best alternative excluding active
    const evaluations = regionsState.map(rs => ({ regionState: rs, analysis: analyzeWindow(rs), anomaly: isAnomalous(rs) }));
    const alternatives = evaluations.filter(e => e.regionState.region.id !== lastActiveRegionId);

    // Prefer healthy alternatives (same criteria as decideActiveRegion)
    let altCandidates = alternatives.filter(e => !e.anomaly.anomalous && e.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.8 && e.analysis.shortFailRate < 0.4 && e.anomaly.haveBaseline);
    if (altCandidates.length === 0) {
      altCandidates = alternatives.filter(e => e.analysis.shortCount >= SHORT_WINDOW_SAMPLES * 0.6);
    }

    if (altCandidates.length > 0) {
      altCandidates.sort((a,b) => a.analysis.shortFailRate - b.analysis.shortFailRate);
      candidateDecision = altCandidates[0];
      candidateId = candidateDecision.regionState.region.id;
      forceRotate = true;
      log('INFO', 'Rotation candidate selected', { candidateId, baselineFail: candidateDecision.analysis.shortFailRate });
    } else {
      log('INFO', 'No suitable alternative found for rotation; keeping current active');
    }
  }

  // Log active region state with EWMA info
  if (lastActiveRegionId) {
    const cur = regionsState.find(r=>r.region.id===lastActiveRegionId);
    if (cur) {
      const a = analyzeWindow(cur);
      const an = isAnomalous(cur);
      log('INFO', `ACTIVE_STATE region=${lastActiveRegionId}`, {
        fail: (a.shortFailRate*100).toFixed(1)+'%',
        latShort: Math.round(a.shortLatMean)+'ms',
        latBaseline: Math.round(a.baselineLatency)+'ms',
        baselineType: a.hasMaturedEWMA ? 'EWMA' : 'LONG',
        ewmaSamples: a.ewmaSamples,
        anomaly: an.reasons[0].type
      });
    }
  }

  // Cooldown handling
  const inCooldown = (nowTs - lastFlipTime) < COOLDOWN_MS;
  if (inCooldown && !forceRotate) {
    const active = regionsState.find(rs=>rs.region.id===lastActiveRegionId);
    if (active) {
      const aa = analyzeWindow(active);
      const critical = aa.maxConsecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD || aa.shortFailRate >= 0.5;
      if (!critical) {
        log('DEBUG','COOLDOWN block', { candidate: candidateId });
        return;
      }
      log('WARN','COOLDOWN_OVERRIDE', { note: 'active critical' });
    } else {
      log('DEBUG','COOLDOWN block (no active)');
      return;
    }
  }

  // Adaptive confirm count based on flap history
  const recentFlips = countRecentFlips();
  let effectiveConfirm = BASE_CONFIRM_COUNT + (recentFlips >= FLAP_THRESHOLD ? FLAP_CONFIRM_INCREMENT : 0);

  // If this rotation is age-triggered, make it faster but still require a short confirmation to avoid DNS flakiness
  if (forceRotate) {
    effectiveConfirm = Math.max(1, Math.floor(BASE_CONFIRM_COUNT / 2)); // quick rotate (e.g. 1)
  }

  // Per-candidate confirmation logic
  if (candidateId !== lastActiveRegionId) {
    if (pendingCandidateId !== candidateId) {
      pendingCandidateId = candidateId;
      pendingConfirmCount = 1;
    } else {
      pendingConfirmCount += 1;
    }

    const candAnalysis = candidateDecision.analysis;
    const candAnomaly = candidateDecision.anomaly;
    log('INFO', `CANDIDATE ${candidateId} (${pendingConfirmCount}/${effectiveConfirm})`, {
      fail: (candAnalysis.shortFailRate*100).toFixed(1)+'%',
      latShort: Math.round(candAnalysis.shortLatMean)+'ms',
      latBaseline: Math.round(candAnalysis.baselineLatency)+'ms',
      anomaly: candAnomaly.reasons[0].type,
      forceRotate
    });

    if (pendingConfirmCount >= effectiveConfirm) {
      // If forceRotate, we accept candidate even if not anomalous, but still prefer non-anomalous
      const acceptCandidate = forceRotate ? (!candAnomaly.anomalous || candAnomaly.haveBaseline) : (!candAnomaly.anomalous && candAnomaly.haveBaseline);

      if (acceptCandidate) {
        const chosenRegion = candidateDecision.regionState.region;
        const regionIps = await resolveHost(chosenRegion.host);
        if (!regionIps.length) {
          log('ERROR','FLIP_ABORT DNS failed', { host: chosenRegion.host });
          pendingCandidateId = null;
          pendingConfirmCount = 0;
          return;
        }

        for (const cluster of CLUSTERS) {
          const filePath = path.join(EDS_DIR, `${cluster.name}.json`);
          const eds = renderEDS(cluster.name, regionIps[0], cluster.port);
          try {
            writeAtomic(filePath, eds);
          } catch (err) {
            log('ERROR','WRITE_EDS failed',{filePath,err: err.message});
          }
        }

        lastActiveRegionId = chosenRegion.id;
        lastFlipTime = nowTs;
        flipHistory.push(nowTs);
        pendingCandidateId = null;
        pendingConfirmCount = 0;
        log('WARN', `FLIP active -> ${chosenRegion.id}`, { forceRotate });
        return;
      } else {
        log('DEBUG','CANDIDATE rejected at confirmation', {
          candidate: candidateId,
          anomalous: candAnomaly.anomalous,
          haveBaseline: candAnomaly.haveBaseline,
          forceRotate
        });
        pendingCandidateId = null;
        pendingConfirmCount = 0;
        return;
      }
    }
  } else {
    pendingCandidateId = null;
    pendingConfirmCount = 0;
  }
}

if (!fs.existsSync(EDS_DIR)) {
  try {
    fs.mkdirSync(EDS_DIR, { recursive: true });
  } catch (err) {
    log('FATAL','Cannot create EDS_DIR',{EDS_DIR,err: err.message});
    process.exit(1);
  }
}

(async function main(){
  log('INFO','Starting health-controller v5 (EWMA baseline, practical+statistical thresholds, max-age rotation)');
  for (let i=0;i<3;i++) await probeAllOnce();
  setInterval(probeAllOnce, INTERVAL_MS);
})();
