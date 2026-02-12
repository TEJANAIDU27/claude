import { useState, useCallback, useMemo } from "react";
import {
  LineChart, Line, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, Label
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// METALLURGICAL LOGIC ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const ELEMENT_COSTS = { Fe: 0.09, Ni: 13.5, Cr: 9.8, Mo: 34.0, C: 0.5, Mn: 1.9, Si: 1.4, Ti: 11.0, V: 28.5 };
const ELEMENT_DENSITIES = { Fe: 7.87, Ni: 8.908, Cr: 7.19, Mo: 10.28, C: 2.26, Mn: 7.21, Si: 2.33, Ti: 4.51, V: 6.11 };

// Koistinen-Marburger: Vf = 1 - exp(-α(Ms - T))
function calcMartensiteVf(comp, quenchMedia) {
  const { C = 0, Ni = 0, Cr = 0, Mo = 0, Mn = 0 } = comp;
  // Ms temperature (°C) - empirical formula
  const Ms = 539 - 423 * C - 30.4 * Mn - 17.7 * Ni - 12.1 * Cr - 7.5 * Mo;
  const alpha = 0.011; // K-M coefficient (typical for steels)
  const quenchTemps = { Water: 25, Oil: 80, Air: 200 };
  const T_quench = quenchTemps[quenchMedia] || 25;
  if (Ms <= T_quench) return { vf: 0, Ms };
  const vf = 1 - Math.exp(-alpha * (Ms - T_quench));
  return { vf: Math.min(1, Math.max(0, vf)), Ms };
}

// Carbon Equivalent (Dearden & O'Neill)
function calcCarbonEquivalent(comp) {
  const { C = 0, Mn = 0, Cr = 0, Mo = 0, V = 0, Ni = 0 } = comp;
  return C + Mn / 6 + (Cr + Mo + V) / 5 + (Ni) / 15;
}

// Hardenability success probability
function calcHardenabilityProb(CE) {
  if (CE < 0.25) return { prob: 0.95, risk: "Low", label: "Excellent" };
  if (CE < 0.35) return { prob: 0.82, risk: "Low-Medium", label: "Good" };
  if (CE < 0.45) return { prob: 0.65, risk: "Medium", label: "Fair" };
  if (CE < 0.60) return { prob: 0.40, risk: "High", label: "Poor" };
  return { prob: 0.15, risk: "Very High", label: "Critical" };
}

// Gibbs Phase Rule & Sigma-phase detection
function checkPhaseStability(comp) {
  const { Cr = 0, Ni = 0, Mo = 0 } = comp;
  const warnings = [];
  const sigmaRisk = Cr > 17 && Ni < 10 && Mo > 2;
  if (sigmaRisk) warnings.push("⚠ Sigma-phase risk: High Cr + low Ni + Mo promotes σ-phase embrittlement at 600–900°C");
  if (Cr > 25) warnings.push("⚠ Ferrite loop: Excessive Cr may stabilize δ-ferrite, reducing toughness");
  if (Ni > 30) warnings.push("⚠ γ-loop: High Ni may suppress martensite formation entirely");
  const phases = sigmaRisk ? "α + γ + σ (unstable)" : "α + γ (stable)";
  return { warnings, phases, stable: warnings.length === 0 };
}

// Ac1 and Ac3 temperatures (°C) – Andrews empirical equations
function calcCriticalTemps(comp) {
  const { C = 0, Mn = 0, Ni = 0, Cr = 0, Mo = 0, Si = 0 } = comp;
  const Ac1 = 723 - 16.9 * Ni + 29.1 * Si + 16.9 * Cr - 10.7 * Mn - 16.9 * Mo;
  const Ac3 = 910 - 203 * Math.sqrt(C) - 15.2 * Ni + 44.7 * Si + 104 * V + 31.5 * Mo - 30 * Mn - 11 * Cr;
  const V = comp.V || 0;
  const Ac3_corrected = 910 - 203 * Math.sqrt(C) - 15.2 * Ni + 44.7 * Si + 104 * V + 31.5 * Mo - 30 * Mn - 11 * Cr;
  return { Ac1: Math.round(Ac1), Ac3: Math.round(Ac3_corrected) };
}

// Hall-Petch: σ_y = σ_0 + k * d^(-1/2)
function calcYieldStrength(comp, grainSize_um) {
  const { C = 0, Mn = 0, Ni = 0, Cr = 0, Mo = 0, Si = 0, V = 0, Ti = 0 } = comp;
  // σ_0: lattice friction stress (MPa)
  const sigma0 = 70 + 32 * Mn + 84 * Si + 35 * Ni + 38 * Cr + 11 * Mo + 350 * C;
  const ky = 21; // Hall-Petch slope (MPa·μm^0.5) for steel
  // Grain refinement from V and Ti (microalloying effect)
  const refinementFactor = 1 - 0.05 * V - 0.03 * Ti; // V/Ti refine grain size
  const effectiveGrain = grainSize_um * Math.max(0.3, refinementFactor);
  const YS = sigma0 + ky * Math.pow(effectiveGrain, -0.5);
  return { YS: Math.round(YS), sigma0: Math.round(sigma0), grainRefined: effectiveGrain };
}

// Hardness from CE and martensite fraction
function calcHardness(CE, vfMartensite) {
  const HRC_martensite = 20 + 60 * CE + 20 * vfMartensite;
  const HV = 3.1 * (HRC_martensite * 9.87 + 51);
  return { HRC: Math.min(65, Math.round(HRC_martensite)), HV: Math.round(HV) };
}

// UTS estimation from YS (empirical ratio for structural steels)
function calcUTS(YS, vfMartensite) {
  const ratio = 1.25 + 0.15 * vfMartensite;
  return Math.round(YS * ratio);
}

// Density: Rule of Mixtures
function calcDensity(comp) {
  let totalWt = 0, weightedDensityInv = 0;
  Object.entries(comp).forEach(([el, wt]) => {
    if (ELEMENT_DENSITIES[el] && wt > 0) {
      totalWt += wt;
      weightedDensityInv += wt / ELEMENT_DENSITIES[el];
    }
  });
  return totalWt / weightedDensityInv;
}

// Cost: Rule of Mixtures
function calcCost(comp) {
  let totalCost = 0, totalWt = 0;
  Object.entries(comp).forEach(([el, wt]) => {
    if (ELEMENT_COSTS[el] && wt > 0) {
      totalCost += wt * ELEMENT_COSTS[el];
      totalWt += wt;
    }
  });
  return totalCost / totalWt;
}

// TTT/CCT curve data generator
function generateTTTData(comp) {
  const { C = 0, Mn = 0, Ni = 0, Cr = 0, Mo = 0 } = comp;
  const CE_ttt = C + Mn / 6 + (Cr + Mo) / 5 + Ni / 15;
  const noseTime = 1 + CE_ttt * 50; // seconds to TTT "nose"
  const noseTemp = 550 - CE_ttt * 30;
  const points = [];
  for (let T = 720; T >= 150; T -= 20) {
    const dt = T - noseTemp;
    const t = noseTime * Math.exp(0.01 * dt * dt / noseTime);
    points.push({ temp: T, time: Math.min(t, 10000) });
  }
  return { points, noseTemp: Math.round(noseTemp), noseTime: Math.round(noseTime) };
}

// Cooling path data for quench media
function getCoolingPath(quenchMedia) {
  const rates = { Water: 300, Oil: 80, Air: 15 }; // °C/s
  const rate = rates[quenchMedia] || 80;
  const path = [];
  for (let t = 0.1; t <= 200; t *= 1.25) {
    const T = Math.max(25, 900 - rate * t);
    path.push({ temp: T, time: Math.round(t * 10) / 10 });
    if (T <= 30) break;
  }
  return path;
}

// Sustainability score
function calcSustainability(comp) {
  const highImpact = { Ni: 3, Mo: 4, V: 2.5, Ti: 2 };
  let score = 100;
  Object.entries(highImpact).forEach(([el, penalty]) => {
    score -= (comp[el] || 0) * penalty;
  });
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Microstructure narrative engine
function generateNarrative(comp, results) {
  const lines = [];
  const { C = 0, V = 0, Ti = 0, Ni = 0, Cr = 0, Mo = 0, Mn = 0 } = comp;

  if (V > 0.05) lines.push(`Vanadium additions (${V.toFixed(2)} wt%) precipitate fine VC/VN carbides, pinning grain boundaries via Zener-pinning and increasing yield strength by ~${Math.round(V * 200)} MPa through grain refinement and precipitation hardening.`);
  if (Ti > 0.01) lines.push(`Titanium (${Ti.toFixed(2)} wt%) forms TiN at high temperatures, suppressing austenite grain growth during austenitization and contributing to a refined microstructure.`);
  if (Mo > 0.5) lines.push(`Molybdenum (${Mo.toFixed(1)} wt%) significantly retards bainite formation in the TTT diagram, shifting the "nose" rightward and enabling through-hardening in thicker sections.`);
  if (Ni > 1) lines.push(`Nickel (${Ni.toFixed(1)} wt%) stabilizes austenite and improves low-temperature toughness via solid-solution strengthening without sacrificing ductility.`);
  if (Cr > 5) lines.push(`Chromium (${Cr.toFixed(1)} wt%) forms protective Cr₂O₃ oxide scale, enhancing oxidation and corrosion resistance. Above 10.5 wt%, full stainless behavior emerges.`);
  if (C < 0.1 && results?.YS > 400) lines.push(`Low carbon content (${C.toFixed(3)} wt%) preserves weldability while high-strength alloy design achieves target properties through microalloying rather than classical carbon strengthening.`);
  if (results?.vfMartensite > 0.8) lines.push(`Rapid quench achieves ${(results.vfMartensite * 100).toFixed(0)}% martensite volume fraction. The lath martensite microstructure is the primary strengthening mechanism, with Ms = ${results.Ms}°C.`);
  if (lines.length === 0) lines.push("Balanced composition in the Fe-Ni-Cr system. Recommend increasing microalloying additions (V, Ti) for improved mechanical performance and grain refinement.");
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT COMPOSITIONS
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_COMP = { Fe: 71.0, Ni: 8.0, Cr: 18.0, Mo: 0.5, C: 0.08, Mn: 1.5, Si: 0.5, Ti: 0.02, V: 0.4 };
const REFERENCE_COMP = { Fe: 68.0, Ni: 9.0, Cr: 19.0, Mo: 2.0, C: 0.03, Mn: 2.0, Si: 1.0, Ti: 0.01, V: 0.0 };

// ─────────────────────────────────────────────────────────────────────────────
// COLOR PALETTE
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  emerald: "#10b981", emeraldDark: "#059669", emeraldLight: "#d1fae5",
  rose: "#f43f5e", roseDark: "#e11d48", roseLight: "#ffe4e6",
  amber: "#f59e0b", amberLight: "#fef3c7",
  slate: "#64748b", slate100: "#f1f5f9", slate200: "#e2e8f0", slate700: "#334155", slate900: "#0f172a",
  white: "#ffffff", indigo: "#6366f1", blue: "#3b82f6",
};

// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILITY COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const Badge = ({ pass, children }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700,
    letterSpacing: "0.05em", textTransform: "uppercase",
    background: pass ? C.emeraldLight : C.roseLight,
    color: pass ? C.emeraldDark : C.roseDark,
    border: `1px solid ${pass ? C.emerald : C.rose}`,
  }}>{children}</span>
);

const Card = ({ children, style = {} }) => (
  <div style={{
    background: C.white, borderRadius: 12, padding: "20px 24px",
    boxShadow: "0 1px 4px rgba(15,23,42,0.08), 0 4px 16px rgba(15,23,42,0.04)",
    border: `1px solid ${C.slate200}`, ...style
  }}>{children}</div>
);

const SectionTitle = ({ icon, children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
    <span style={{ fontSize: 18 }}>{icon}</span>
    <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: "0.08em",
      textTransform: "uppercase", color: C.slate700 }}>{children}</h3>
  </div>
);

const MetricCard = ({ label, value, unit, pass, delta }) => (
  <div style={{
    background: C.slate100, borderRadius: 10, padding: "14px 16px",
    border: `1px solid ${C.slate200}`,
  }}>
    <div style={{ fontSize: 11, color: C.slate, fontWeight: 600, textTransform: "uppercase",
      letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
      <span style={{ fontSize: 24, fontWeight: 800, color: C.slate900, fontFamily: "'IBM Plex Mono', monospace" }}>{value}</span>
      <span style={{ fontSize: 12, color: C.slate, fontWeight: 500 }}>{unit}</span>
    </div>
    {delta !== undefined && (
      <div style={{ fontSize: 11, marginTop: 3, color: delta >= 0 ? C.emeraldDark : C.roseDark, fontWeight: 600 }}>
        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} vs. reference
      </div>
    )}
    {pass !== undefined && <div style={{ marginTop: 6 }}><Badge pass={pass}>{pass ? "Pass" : "Fail"}</Badge></div>}
  </div>
);

const Gauge = ({ value, max = 100, label, color }) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.slate, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.slate900, fontFamily: "'IBM Plex Mono', monospace" }}>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 7, borderRadius: 99, background: C.slate200, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color,
          borderRadius: 99, transition: "width 0.6s cubic-bezier(0.34,1.56,0.64,1)" }} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function AlloyRedesign() {
  const [comp, setComp] = useState({ ...DEFAULT_COMP });
  const [alloyName, setAlloyName] = useState("Custom 316L-V Mod");
  const [quench, setQuench] = useState("Water");
  const [grainSize, setGrainSize] = useState(25);
  const [targetYS, setTargetYS] = useState(600);
  const [activeTab, setActiveTab] = useState("dashboard");

  // Normalise composition so Fe = 100 - rest
  const normComp = useMemo(() => {
    const others = Object.entries(comp).filter(([k]) => k !== "Fe").reduce((s, [, v]) => s + v, 0);
    return { ...comp, Fe: Math.max(0, 100 - others) };
  }, [comp]);

  const results = useMemo(() => {
    const { vf: vfMartensite, Ms } = calcMartensiteVf(normComp, quench);
    const CE = calcCarbonEquivalent(normComp);
    const hardenability = calcHardenabilityProb(CE);
    const phase = checkPhaseStability(normComp);
    const { Ac1, Ac3 } = calcCriticalTemps(normComp);
    const { YS, sigma0, grainRefined } = calcYieldStrength(normComp, grainSize);
    const { HRC, HV } = calcHardness(CE, vfMartensite);
    const UTS = calcUTS(YS, vfMartensite);
    const density = calcDensity(normComp);
    const cost = calcCost(normComp);
    const sustainability = calcSustainability(normComp);
    const ttt = generateTTTData(normComp);
    const coolingPath = getCoolingPath(quench);
    const narrative = generateNarrative(normComp, { YS, vfMartensite, Ms });

    // Reference calcs
    const refYS = calcYieldStrength(REFERENCE_COMP, 40).YS;
    const refUTS = calcUTS(refYS, calcMartensiteVf(REFERENCE_COMP, "Water").vf);
    const refDensity = calcDensity(REFERENCE_COMP);
    const refHRC = calcHardness(calcCarbonEquivalent(REFERENCE_COMP), calcMartensiteVf(REFERENCE_COMP, "Water").vf).HRC;

    return {
      vfMartensite, Ms, CE, hardenability, phase, Ac1, Ac3,
      YS, sigma0, grainRefined, HRC, HV, UTS, density, cost,
      sustainability, ttt, coolingPath, narrative,
      refYS, refUTS, refDensity, refHRC,
      strengthToWeight: (UTS / density).toFixed(0),
      refStrengthToWeight: Math.round(refUTS / refDensity),
    };
  }, [normComp, quench, grainSize]);

  const updateComp = useCallback((el, val) => {
    setComp(prev => ({ ...prev, [el]: Math.max(0, Math.min(50, parseFloat(val) || 0)) }));
  }, []);

  const handleExport = () => {
    const lines = [
      `ALLOY TECHNICAL REPORT — ${alloyName}`,
      `Generated: ${new Date().toISOString()}`,
      "═".repeat(60),
      "",
      "COMPOSITION (wt%)",
      ...Object.entries(normComp).map(([k, v]) => `  ${k.padEnd(4)} : ${v.toFixed(3)}`),
      "",
      "CALCULATED PROPERTIES",
      `  Yield Strength  : ${results.YS} MPa`,
      `  UTS             : ${results.UTS} MPa`,
      `  Hardness        : ${results.HRC} HRC / ${results.HV} HV`,
      `  Density         : ${results.density.toFixed(3)} g/cm³`,
      `  Cost            : $${results.cost.toFixed(2)}/kg`,
      "",
      "HEAT TREATMENT",
      `  Ac1 : ${results.Ac1}°C`,
      `  Ac3 : ${results.Ac3}°C`,
      `  Ms  : ${results.Ms}°C`,
      `  Martensite Vf (${quench} quench): ${(results.vfMartensite * 100).toFixed(1)}%`,
      "",
      "CARBON EQUIVALENT (Dearden & O'Neill)",
      `  CE = ${results.CE.toFixed(3)} — ${results.hardenability.label}`,
      "",
      "PHASE STABILITY",
      `  ${results.phase.phases}`,
      ...(results.phase.warnings.length ? results.phase.warnings.map(w => `  ${w}`) : ["  No stability warnings"]),
      "",
      "SUSTAINABILITY SCORE",
      `  ${results.sustainability}/100`,
      "",
      "MICROSTRUCTURE INSIGHTS",
      ...results.narrative.map(n => `  • ${n}`),
      "",
      "═".repeat(60),
      "Generated by AI-Driven Alloy Redesign & Simulation Platform",
    ].join("\n");

    const blob = new Blob([lines], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${alloyName.replace(/\s+/g, "_")}_TechReport.txt`;
    a.click();
  };

  // TTT chart data: merge TTT curve and cooling path
  const tttChartData = useMemo(() => {
    // Build indexed by temperature
    const map = {};
    results.ttt.points.forEach(p => { map[p.temp] = { temp: p.temp, ttt: p.time }; });
    results.coolingPath.forEach(p => {
      const t = Math.round(p.temp / 20) * 20;
      if (map[t]) map[t].cooling = p.time;
    });
    return Object.values(map).sort((a, b) => b.temp - a.temp);
  }, [results]);

  // Ashby scatter data
  const ashbyData = useMemo(() => [
    { name: alloyName, stw: parseFloat(results.strengthToWeight), cost: results.cost, isMain: true },
    { name: "304 SS Ref", stw: results.refStrengthToWeight, cost: calcCost(REFERENCE_COMP), isMain: false },
    { name: "4140 Steel", stw: 108, cost: 0.7, isMain: false },
    { name: "Ti-6Al-4V", stw: 254, cost: 22, isMain: false },
    { name: "Inconel 718", stw: 145, cost: 45, isMain: false },
    { name: "Al 7075", stw: 197, cost: 3.2, isMain: false },
    { name: "Maraging 350", stw: 310, cost: 38, isMain: false },
  ], [alloyName, results]);

  const elements = ["Fe", "Ni", "Cr", "Mo", "C", "Mn", "Si", "Ti", "V"];
  const quenchOptions = ["Water", "Oil", "Air"];
  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "ttt", label: "TTT / CCT" },
    { id: "ashby", label: "Ashby Map" },
    { id: "insights", label: "Microstructure" },
  ];

  const overallPass = results.hardenability.prob > 0.5 && results.phase.stable && results.YS >= targetYS;

  return (
    <div style={{
      fontFamily: "'DM Sans', 'Helvetica Neue', Arial, sans-serif",
      background: "#f8fafc",
      minHeight: "100vh",
      color: C.slate900,
    }}>
      {/* ── HEADER ── */}
      <div style={{
        background: C.slate900,
        borderBottom: `3px solid ${C.emerald}`,
        padding: "0 32px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 62,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `linear-gradient(135deg, ${C.emerald}, #0ea5e9)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16,
          }}>⚛</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>
              AlloyOS <span style={{ color: C.emerald }}>Research</span>
            </div>
            <div style={{ fontSize: 10, color: C.slate, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              AI-Driven Alloy Redesign Platform
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge pass={overallPass}>{overallPass ? "Design Validated" : "Review Required"}</Badge>
          <button onClick={handleExport} style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 16px", borderRadius: 8, border: `1px solid ${C.emerald}`,
            background: "transparent", color: C.emerald, fontSize: 12, fontWeight: 700,
            cursor: "pointer", letterSpacing: "0.04em", transition: "all 0.2s",
          }}
            onMouseEnter={e => e.target.style.background = C.emerald + "22"}
            onMouseLeave={e => e.target.style.background = "transparent"}
          >
            ⬇ Export Report
          </button>
        </div>
      </div>

      {/* ── NAV TABS ── */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.slate200}`, padding: "0 32px", display: "flex", gap: 0 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: "14px 20px", background: "none", border: "none", cursor: "pointer",
            fontSize: 13, fontWeight: activeTab === t.id ? 700 : 500,
            color: activeTab === t.id ? C.emeraldDark : C.slate,
            borderBottom: `3px solid ${activeTab === t.id ? C.emerald : "transparent"}`,
            marginBottom: -1, transition: "all 0.15s",
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {/* ══════════════════════════════════════════════════════════
            TAB: DASHBOARD
        ══════════════════════════════════════════════════════════ */}
        {activeTab === "dashboard" && (
          <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 20 }}>
            {/* ── LEFT: INPUT PANEL ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <SectionTitle icon="🧪">Alloy Designation</SectionTitle>
                <input value={alloyName} onChange={e => setAlloyName(e.target.value)} style={{
                  width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.slate200}`,
                  fontSize: 14, fontWeight: 600, color: C.slate900, background: C.slate100,
                  outline: "none", boxSizing: "border-box",
                }} />
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, color: C.slate, fontWeight: 700, letterSpacing: "0.07em",
                    textTransform: "uppercase", marginBottom: 4 }}>Target Yield Strength (MPa)</div>
                  <input type="number" value={targetYS} onChange={e => setTargetYS(+e.target.value)} style={{
                    width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.slate200}`,
                    fontSize: 14, fontWeight: 600, color: C.slate900, background: C.slate100,
                    outline: "none", boxSizing: "border-box",
                  }} />
                </div>
              </Card>

              <Card>
                <SectionTitle icon="⚗️">Composition (wt%)</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {elements.map(el => (
                    <div key={el} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{
                        width: 28, fontSize: 12, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace",
                        color: el === "Fe" ? C.blue : C.slate900,
                        flexShrink: 0,
                      }}>{el}</span>
                      <input
                        type="range" min={0} max={el === "Fe" ? 99 : el === "C" ? 2 : 30}
                        step={el === "C" ? 0.01 : el === "Ti" || el === "V" ? 0.05 : 0.5}
                        value={el === "Fe" ? normComp.Fe : comp[el]}
                        onChange={e => el !== "Fe" && updateComp(el, e.target.value)}
                        disabled={el === "Fe"}
                        style={{ flex: 1, accentColor: C.emerald }}
                      />
                      <input
                        type="number"
                        value={el === "Fe" ? normComp.Fe.toFixed(1) : comp[el]}
                        onChange={e => el !== "Fe" && updateComp(el, e.target.value)}
                        readOnly={el === "Fe"}
                        step={el === "C" ? 0.01 : 0.1}
                        style={{
                          width: 52, padding: "4px 6px", borderRadius: 6, border: `1px solid ${C.slate200}`,
                          fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
                          color: C.slate900, background: el === "Fe" ? C.slate100 : C.white,
                          outline: "none", textAlign: "right",
                        }}
                      />
                      <span style={{ fontSize: 10, color: C.slate, width: 14 }}>%</span>
                    </div>
                  ))}
                </div>
                <div style={{
                  marginTop: 12, padding: "8px 12px", borderRadius: 8,
                  background: Math.abs(Object.values(normComp).reduce((a, b) => a + b, 0) - 100) < 0.5 ? C.emeraldLight : C.roseLight,
                  fontSize: 11, color: C.slate700, fontWeight: 600, textAlign: "center",
                }}>
                  Total: {Object.values(normComp).reduce((a, b) => a + b, 0).toFixed(2)} wt% (Fe = {normComp.Fe.toFixed(2)}%)
                </div>
              </Card>

              <Card>
                <SectionTitle icon="🌡">Process Parameters</SectionTitle>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: C.slate, fontWeight: 700, letterSpacing: "0.07em",
                    textTransform: "uppercase", marginBottom: 8 }}>Quench Media</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {quenchOptions.map(q => (
                      <button key={q} onClick={() => setQuench(q)} style={{
                        flex: 1, padding: "8px 0", borderRadius: 8, border: `1.5px solid ${quench === q ? C.emerald : C.slate200}`,
                        background: quench === q ? C.emeraldLight : C.white,
                        color: quench === q ? C.emeraldDark : C.slate,
                        fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.15s",
                      }}>{q}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: C.slate, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                      Grain Size (μm)
                    </span>
                    <span style={{ fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>{grainSize} μm</span>
                  </div>
                  <input type="range" min={2} max={100} value={grainSize} onChange={e => setGrainSize(+e.target.value)}
                    style={{ width: "100%", accentColor: C.emerald }} />
                </div>
              </Card>
            </div>

            {/* ── RIGHT: ANALYSIS OUTPUT ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Analysis row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                {/* Hardenability */}
                <Card style={{ background: results.hardenability.prob > 0.5 ? C.emeraldLight : C.roseLight }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
                    color: results.hardenability.prob > 0.5 ? C.emeraldDark : C.roseDark, marginBottom: 8 }}>
                    Hardenability
                  </div>
                  <div style={{ fontSize: 36, fontWeight: 900, color: results.hardenability.prob > 0.5 ? C.emeraldDark : C.roseDark,
                    fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1 }}>
                    {(results.hardenability.prob * 100).toFixed(0)}<span style={{ fontSize: 16 }}>%</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, color: C.slate700 }}>
                    CE = {results.CE.toFixed(3)} — {results.hardenability.label}
                  </div>
                  <div style={{ marginTop: 8 }}><Badge pass={results.hardenability.prob > 0.5}>
                    {results.hardenability.prob > 0.5 ? "Quench Success" : "Risk of Soft Spots"}
                  </Badge></div>
                </Card>

                {/* Sustainability */}
                <Card>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
                    color: C.slate, marginBottom: 8 }}>Sustainability</div>
                  <div style={{ fontSize: 36, fontWeight: 900, color: results.sustainability > 60 ? C.emeraldDark : C.amber,
                    fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1 }}>
                    {results.sustainability}<span style={{ fontSize: 16 }}>/100</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, color: C.slate700 }}>
                    Cost: ${results.cost.toFixed(2)}/kg
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Gauge value={results.sustainability} max={100} label="Eco Score"
                      color={results.sustainability > 60 ? C.emerald : C.amber} />
                  </div>
                </Card>

                {/* Phase Stability */}
                <Card style={{ background: results.phase.stable ? C.white : C.amberLight }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
                    color: C.slate, marginBottom: 8 }}>Phase Stability</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: results.phase.stable ? C.emeraldDark : C.amber,
                    marginBottom: 6 }}>{results.phase.phases}</div>
                  {results.phase.warnings.length === 0 ?
                    <Badge pass={true}>Gibbs-stable</Badge> :
                    results.phase.warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: 11, color: C.amber, marginTop: 4, lineHeight: 1.5 }}>{w}</div>
                    ))
                  }
                </Card>
              </div>

              {/* Property Matrix */}
              <Card>
                <SectionTitle icon="📊">Property Matrix — Calculated vs. Reference</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                  <MetricCard label="Yield Strength" value={results.YS} unit="MPa"
                    pass={results.YS >= targetYS} delta={results.YS - results.refYS} />
                  <MetricCard label="UTS" value={results.UTS} unit="MPa"
                    delta={results.UTS - results.refUTS} />
                  <MetricCard label="Hardness" value={results.HRC} unit="HRC"
                    delta={results.HRC - results.refHRC} />
                  <MetricCard label="Density" value={results.density.toFixed(3)} unit="g/cm³"
                    delta={parseFloat((results.density - results.refDensity).toFixed(3))} />
                </div>
              </Card>

              {/* Heat Treatment Vault */}
              <Card>
                <SectionTitle icon="🔥">Heat Treatment Vault</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
                  {[
                    { label: "Ac1", value: results.Ac1, unit: "°C" },
                    { label: "Ac3", value: results.Ac3, unit: "°C" },
                    { label: "Ms", value: results.Ms, unit: "°C" },
                    { label: "Martensite Vf", value: (results.vfMartensite * 100).toFixed(1), unit: "%" },
                    { label: "Str/Weight", value: results.strengthToWeight, unit: "kN·m/kg" },
                  ].map(m => (
                    <div key={m.label} style={{
                      background: C.slate900, borderRadius: 10, padding: "12px 14px",
                    }}>
                      <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.07em",
                        textTransform: "uppercase", marginBottom: 6 }}>{m.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 900, color: "#fff",
                        fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1 }}>
                        {m.value}<span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 2 }}>{m.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Gauges row */}
              <Card>
                <SectionTitle icon="📈">Performance Gauges</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                  <Gauge value={results.YS} max={Math.max(1200, results.YS)} label="Yield Strength" color={C.emerald} />
                  <Gauge value={results.vfMartensite * 100} max={100} label={`Martensite Vf (${quench})`} color={C.indigo} />
                  <Gauge value={results.hardenability.prob * 100} max={100} label="Quench Probability" color={C.blue} />
                  <Gauge value={results.sustainability} max={100} label="Sustainability Score" color={C.amber} />
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            TAB: TTT / CCT
        ══════════════════════════════════════════════════════════ */}
        {activeTab === "ttt" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20 }}>
            <Card>
              <SectionTitle icon="📉">TTT Diagram with {quench} Cooling Path</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {quenchOptions.map(q => (
                  <button key={q} onClick={() => setQuench(q)} style={{
                    padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${quench === q ? C.emerald : C.slate200}`,
                    background: quench === q ? C.emeraldLight : C.white,
                    color: quench === q ? C.emeraldDark : C.slate,
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>{q}</button>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={tttChartData} margin={{ top: 10, right: 30, left: 20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.slate200} />
                  <XAxis dataKey="time" type="number" scale="log" domain={[0.1, 10000]}
                    tickFormatter={v => v >= 1000 ? `${(v / 60).toFixed(0)}m` : `${v}s`}
                    label={{ value: "Time (s) — log scale", position: "insideBottom", offset: -20,
                      style: { fontSize: 11, fill: C.slate } }} />
                  <YAxis domain={[100, 750]} label={{ value: "Temperature (°C)", angle: -90,
                    position: "insideLeft", offset: 10, style: { fontSize: 11, fill: C.slate } }} />
                  <Tooltip formatter={(v, n) => [typeof v === "number" ? v.toFixed(1) : v, n]}
                    labelFormatter={l => `Time: ${l}s`}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend verticalAlign="top" height={36} />
                  <ReferenceLine y={results.ttt.noseTemp} stroke={C.amber} strokeDasharray="5 3"
                    label={{ value: `Nose: ${results.ttt.noseTemp}°C`, fill: C.amber, fontSize: 11 }} />
                  <ReferenceLine y={results.Ms} stroke={C.rose} strokeDasharray="5 3"
                    label={{ value: `Ms: ${results.Ms}°C`, fill: C.rose, fontSize: 11 }} />
                  <Line dataKey="ttt" name="TTT Boundary" stroke={C.blue} strokeWidth={2.5}
                    dot={false} connectNulls activeDot={{ r: 4 }} />
                  <Line dataKey="cooling" name={`${quench} Cooling Path`}
                    stroke={quench === "Water" ? C.emerald : quench === "Oil" ? C.amber : C.rose}
                    strokeWidth={2} strokeDasharray={quench === "Air" ? "6 4" : ""}
                    dot={false} connectNulls activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card>
                <SectionTitle icon="🔥">Critical Temperatures</SectionTitle>
                {[
                  { l: "Ac1 (eutectoid)", v: results.Ac1, u: "°C", hint: "Onset of austenite formation" },
                  { l: "Ac3 (full austenite)", v: results.Ac3, u: "°C", hint: "Complete austenite above" },
                  { l: "Ms (martensite start)", v: results.Ms, u: "°C", hint: "Athermal transformation start" },
                ].map(m => (
                  <div key={m.l} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: C.slate, fontWeight: 600, textTransform: "uppercase",
                      letterSpacing: "0.05em" }}>{m.l}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace",
                      color: C.slate900 }}>{m.v}°C</div>
                    <div style={{ fontSize: 11, color: C.slate }}>{m.hint}</div>
                  </div>
                ))}
              </Card>
              <Card>
                <SectionTitle icon="❄️">Martensite Transformation</SectionTitle>
                <div style={{ fontSize: 11, color: C.slate, marginBottom: 8 }}>
                  Koistinen-Marburger: Vf = 1 − exp(−α·(Ms−T))
                </div>
                <div style={{ fontSize: 32, fontWeight: 900, color: results.vfMartensite > 0.7 ? C.emeraldDark : C.amber,
                  fontFamily: "'IBM Plex Mono', monospace" }}>
                  {(results.vfMartensite * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: 12, color: C.slate, marginTop: 4 }}>
                  Martensite volume fraction<br />after {quench.toLowerCase()} quench
                </div>
                <div style={{ marginTop: 12 }}>
                  <Gauge value={results.vfMartensite * 100} max={100} label="Vf" color={C.indigo} />
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            TAB: ASHBY MAP
        ══════════════════════════════════════════════════════════ */}
        {activeTab === "ashby" && (
          <Card>
            <SectionTitle icon="🗺">Ashby Property Map — Specific Strength vs. Cost</SectionTitle>
            <div style={{ fontSize: 12, color: C.slate, marginBottom: 16 }}>
              Logarithmic axes. Highlighted point = {alloyName}. Ideal materials: upper-left quadrant.
            </div>
            <ResponsiveContainer width="100%" height={480}>
              <ScatterChart margin={{ top: 20, right: 60, bottom: 60, left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.slate200} />
                <XAxis dataKey="cost" type="number" scale="log" domain={[0.1, 100]}
                  tickFormatter={v => `$${v}`} name="Cost ($/kg)"
                  label={{ value: "Cost per kg (USD, log scale)", position: "insideBottom", offset: -30,
                    style: { fontSize: 12, fill: C.slate } }} />
                <YAxis dataKey="stw" type="number" scale="log" domain={[50, 400]}
                  tickFormatter={v => `${v}`} name="Specific Strength"
                  label={{ value: "Specific Strength (MPa·cm³/g)", angle: -90,
                    position: "insideLeft", offset: -10, style: { fontSize: 12, fill: C.slate } }} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ payload }) => {
                    if (!payload || !payload.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{ background: C.white, border: `1px solid ${C.slate200}`, borderRadius: 10,
                        padding: "12px 16px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)" }}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: d.isMain ? C.emeraldDark : C.slate900 }}>
                          {d.name}
                        </div>
                        <div style={{ fontSize: 12, color: C.slate }}>Specific Strength: {d.stw} MPa·cm³/g</div>
                        <div style={{ fontSize: 12, color: C.slate }}>Cost: ${typeof d.cost === "number" ? d.cost.toFixed(2) : d.cost}/kg</div>
                      </div>
                    );
                  }}
                />
                <Scatter
                  data={ashbyData.filter(d => !d.isMain)}
                  name="Reference Alloys" fill={C.slate}
                  shape={(props) => {
                    const { cx, cy, payload } = props;
                    return (
                      <g>
                        <circle cx={cx} cy={cy} r={7} fill={C.slate200} stroke={C.slate} strokeWidth={1.5} />
                        <text x={cx + 10} y={cy + 4} fontSize={10} fill={C.slate} fontWeight={600}>{payload.name}</text>
                      </g>
                    );
                  }}
                />
                <Scatter
                  data={ashbyData.filter(d => d.isMain)}
                  name={alloyName} fill={C.emerald}
                  shape={(props) => {
                    const { cx, cy, payload } = props;
                    return (
                      <g>
                        <circle cx={cx} cy={cy} r={14} fill={C.emeraldLight} stroke={C.emerald} strokeWidth={2.5} />
                        <circle cx={cx} cy={cy} r={6} fill={C.emerald} />
                        <text x={cx + 18} y={cy + 4} fontSize={11} fill={C.emeraldDark} fontWeight={800}>{payload.name}</text>
                      </g>
                    );
                  }}
                />
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16 }}>
              {ashbyData.map(d => (
                <div key={d.name} style={{
                  padding: "10px 14px", borderRadius: 8,
                  background: d.isMain ? C.emeraldLight : C.slate100,
                  border: `1px solid ${d.isMain ? C.emerald : C.slate200}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: d.isMain ? C.emeraldDark : C.slate900 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: C.slate, marginTop: 2 }}>
                    {d.stw} MPa·cm³/g · ${typeof d.cost === "number" ? d.cost.toFixed(2) : d.cost}/kg
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ══════════════════════════════════════════════════════════
            TAB: MICROSTRUCTURE INSIGHTS
        ══════════════════════════════════════════════════════════ */}
        {activeTab === "insights" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <SectionTitle icon="🔬">Microstructure Prediction Engine</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {results.narrative.map((line, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 14, padding: "14px 16px",
                      background: C.slate100, borderRadius: 10, border: `1px solid ${C.slate200}`,
                    }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                        background: C.emerald, display: "flex", alignItems: "center",
                        justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 800,
                      }}>{i + 1}</div>
                      <div style={{ fontSize: 13, color: C.slate700, lineHeight: 1.7 }}>{line}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <SectionTitle icon="🧮">Hall-Petch Breakdown</SectionTitle>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  {[
                    { l: "Lattice Friction (σ₀)", v: results.sigma0, u: "MPa", desc: "SS strengthening" },
                    { l: "Grain Refined Size", v: results.grainRefined.toFixed(1), u: "μm", desc: "After V/Ti additions" },
                    { l: "Predicted YS", v: results.YS, u: "MPa", desc: `Target: ${targetYS} MPa` },
                  ].map(m => (
                    <div key={m.l} style={{ background: C.slate100, borderRadius: 10, padding: "14px 16px",
                      border: `1px solid ${C.slate200}` }}>
                      <div style={{ fontSize: 10, color: C.slate, fontWeight: 700, textTransform: "uppercase",
                        letterSpacing: "0.06em", marginBottom: 4 }}>{m.l}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'IBM Plex Mono', monospace",
                        color: C.slate900 }}>{m.v} <span style={{ fontSize: 12 }}>{m.u}</span></div>
                      <div style={{ fontSize: 11, color: C.slate, marginTop: 4 }}>{m.desc}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14, padding: "12px 14px", background: "#eff6ff", borderRadius: 10,
                  border: "1px solid #bfdbfe", fontSize: 12, color: "#1e40af", fontFamily: "'IBM Plex Mono', monospace" }}>
                  σ_y = {results.sigma0} + 21 × ({results.grainRefined.toFixed(1)})^(−1/2) = <strong>{results.YS} MPa</strong>
                </div>
              </Card>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card>
                <SectionTitle icon="🏗">Strengthening Mechanisms</SectionTitle>
                {[
                  { l: "Solid Solution", v: Math.min(100, (normComp.Ni * 3 + normComp.Mn * 4 + normComp.Si * 8)), color: C.blue },
                  { l: "Grain Refinement", v: Math.min(100, (normComp.V * 120 + normComp.Ti * 80)), color: C.emerald },
                  { l: "Precipitation", v: Math.min(100, normComp.C * 300 + normComp.V * 80), color: C.indigo },
                  { l: "Martensite", v: results.vfMartensite * 100, color: C.rose },
                ].map(m => (
                  <div key={m.l} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.slate700 }}>{m.l}</span>
                      <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>
                        {Math.round(m.v)}%
                      </span>
                    </div>
                    <div style={{ height: 8, borderRadius: 99, background: C.slate200, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, m.v)}%`, background: m.color,
                        borderRadius: 99, transition: "width 0.7s ease" }} />
                    </div>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionTitle icon="💰">Elemental Cost Breakdown</SectionTitle>
                {Object.entries(normComp)
                  .filter(([k, v]) => v > 0.05)
                  .sort(([, a], [, b]) => b - a)
                  .map(([el, wt]) => {
                    const elCost = (wt * (ELEMENT_COSTS[el] || 0));
                    const totalCost = Object.entries(normComp).reduce((s, [k, v]) => s + v * (ELEMENT_COSTS[k] || 0), 0);
                    const pct = totalCost > 0 ? (elCost / totalCost) * 100 : 0;
                    return (
                      <div key={el} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                        <span style={{ width: 28, fontSize: 12, fontWeight: 700,
                          fontFamily: "'IBM Plex Mono', monospace", color: C.slate900 }}>{el}</span>
                        <div style={{ flex: 1, height: 8, borderRadius: 99, background: C.slate200, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct}%`, background: C.emerald, borderRadius: 99 }} />
                        </div>
                        <span style={{ fontSize: 11, color: C.slate, width: 36, textAlign: "right",
                          fontFamily: "'IBM Plex Mono', monospace" }}>{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })}
                <div style={{ marginTop: 12, padding: "10px 14px", background: C.slate100, borderRadius: 8,
                  display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.slate700 }}>Total Cost</span>
                  <span style={{ fontSize: 16, fontWeight: 900, fontFamily: "'IBM Plex Mono', monospace",
                    color: C.slate900 }}>${results.cost.toFixed(2)}<span style={{ fontSize: 11, color: C.slate }}>/kg</span></span>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>

      {/* ── FOOTER ── */}
      <div style={{ borderTop: `1px solid ${C.slate200}`, padding: "14px 32px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        background: C.white, marginTop: 16, fontSize: 11, color: C.slate }}>
        <div>AlloyOS Research Platform · Koistinen-Marburger · Dearden-O'Neill · Hall-Petch · Gibbs Phase Rule</div>
        <div style={{ display: "flex", gap: 16 }}>
          <span>CE: <strong style={{ color: C.slate900 }}>{results.CE.toFixed(3)}</strong></span>
          <span>YS: <strong style={{ color: C.slate900 }}>{results.YS} MPa</strong></span>
          <span>UTS: <strong style={{ color: C.slate900 }}>{results.UTS} MPa</strong></span>
          <span>ρ: <strong style={{ color: C.slate900 }}>{results.density.toFixed(3)} g/cm³</strong></span>
        </div>
      </div>
    </div>
  );
}
