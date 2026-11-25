import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { agentWindowPlacement, agentOrbitPoint, createAgentOrbitMotion } from "../../web-ui/app/components/agents/orbits.js";

function orbitButton(size: number, narrow: boolean) {
  const properties = new Map<string, string>();
  const style = {
    visibility: "", opacity: "1",
    setProperty(name: string, value: string) { properties.set(name, value); },
  };
  return {
    style, inert: false, setAttribute: vi.fn(),
    get offsetHeight() { return Number.parseFloat(properties.get("--orb-size") ?? String(size)); },
    querySelector() { return { offsetHeight: 14, offsetTop: this.offsetHeight + 14, offsetWidth: narrow ? 100 : 160 }; },
    coordinate(axis: "x" | "y") { return Number.parseFloat(properties.get(`--orbit-${axis}`)!); },
    scale() { return Number(properties.get("--orbit-scale")); },
  };
}

function scene(width: number, height: number, top: number, reducedMotion = false) {
  let queued: ((time: number) => void) | undefined, now = 1;
  const narrow = width < 580;
  const nodes = new Map(["abot", "scout", "builder"].map((id) =>
    [id, orbitButton(id === "abot" ? narrow ? 78 : 100 : narrow ? 49 : 74, narrow)] as const));
  const field = { clientWidth: width, clientHeight: height, getBoundingClientRect: () => ({ left: 0 }), dataset: {} };
  const chatWidth = Math.min(590, width - 24);
  const chat = { hidden: true, offsetWidth: chatWidth, offsetHeight: height - top - 12, offsetTop: top,
    getBoundingClientRect: () => ({ left: (width - chatWidth) / 2 }) };
  const media = { matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const viewport = {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), matchMedia: () => media,
    requestAnimationFrame(callback: (time: number) => void) { queued = callback; return 1; },
    cancelAnimationFrame() { queued = undefined; },
  };
  const guides = Array.from({ length: 2 }, () => ({
    hidden: true, style: { left: "", top: "", width: "", height: "", transform: "" },
  }));
  const motion = createAgentOrbitMotion({ field, chat, nodes, guides, viewport,
    documentRoot: { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  function tick(count: number) {
    for (let i = 0; i < count && queued; i++) {
      const frame = queued;
      queued = undefined;
      frame(now += 16);
    }
  }
  motion.update([...nodes.keys()]);
  motion.setActive(true);
  tick(1);
  return {
    node: (id: string) => nodes.get(id)!, guides, tick, motion, framePending: () => Boolean(queued),
    setAgents(ids: string[]) {
      for (const id of ids) if (!nodes.has(id)) nodes.set(id, orbitButton(74, narrow));
      motion.update(ids);
    },
    resize(nextWidth: number, nextHeight: number) {
      field.clientWidth = nextWidth;
      field.clientHeight = nextHeight;
      tick(1);
    },
    select(id: string) { chat.hidden = !id; motion.select(id); },
  };
}

describe("orbit conversation focus", () => {
  test.each([
    [1150, 800, 240], [780, 550, 150], [375, 650, 150], [375, 700, 180],
  ])("only the selected agent approaches at %i × %i", (width, height, panelTop) => {
    const s = scene(width, height, panelTop), abot = s.node("abot"), scout = s.node("scout");
    const center = [abot.coordinate("x"), abot.coordinate("y")];
    const initial = [scout.coordinate("x"), scout.coordinate("y")];
    s.select("scout");
    s.tick(10);
    const midX = scout.coordinate("x");
    expect(midX).not.toBe(initial[0]);
    expect(midX).not.toBe(width / 2);
    expect([abot.coordinate("x"), abot.coordinate("y")]).toEqual(center);
    s.tick(20);
    expect([abot.coordinate("x"), abot.coordinate("y")]).toEqual(center);
    expect(abot.scale()).toBe(1);
    expect(abot.style.visibility).toBe("hidden");
    expect(abot.inert).toBe(true);
    expect(scout.coordinate("x")).toBe(width / 2);
    const bottom = scout.coordinate("y") + (scout.offsetHeight / 2 + 28) * scout.scale();
    expect(bottom).toBeLessThanOrEqual(panelTop - 7.9);
    s.select("");
    s.tick(22);
    expect(abot.inert).toBe(false);
    expect(abot.style.visibility).toBe("");
    expect(scout.scale()).toBe(1);
    expect(Math.abs(scout.coordinate("x") - initial[0])).toBeLessThan(2);
  });

  test("coordinator focus and return are immediate with reduced motion", () => {
    const s = scene(780, 550, 150, true), abot = s.node("abot");
    const centerY = abot.coordinate("y");
    s.select("abot");
    expect(abot.coordinate("y") + (abot.offsetHeight / 2 + 28) * abot.scale()).toBeLessThanOrEqual(142.01);
    expect(abot.style.visibility).toBe("");
    expect(abot.inert).toBe(false);
    s.select("");
    expect(abot.coordinate("y")).toBe(centerY);
    expect(abot.scale()).toBe(1);
    expect(s.node("scout").inert).toBe(false);
  });
});

describe("orbit depth and guides", () => {
  test("draws only occupied guides and keeps the moving portraits on their guides after resize and roster changes", () => {
    const s = scene(1150, 800, 240);
    function expectOnGuide(id: string, index: number) {
      const guide = s.guides[index]!;
      expect(guide.hidden).toBe(false);
      const node = s.node(id), style = guide.style;
      const x = node.coordinate("x") - Number.parseFloat(style.left);
      const y = node.coordinate("y") - Number.parseFloat(style.top);
      const radians = Number(style.transform.match(/rotate\(([-.\d]+)rad\)/)?.[1]);
      const rx = Number.parseFloat(style.width) / 2, ry = Number.parseFloat(style.height) / 2;
      const u = (x * Math.cos(radians) + y * Math.sin(radians)) / rx;
      const v = (-x * Math.sin(radians) + y * Math.cos(radians)) / ry;
      expect(u * u + v * v).toBeCloseTo(1, 3);
    }
    const ids = ["abot", ...Array.from({ length: 20 }, (_, i) => "worker-" + i)];
    s.setAgents(["abot"]);
    expect(s.guides.map(guide => guide.hidden)).toEqual([true, true]);
    s.setAgents(ids.slice(0, 7));
    expect(s.guides[1]!.hidden).toBe(true);
    expectOnGuide("worker-0", 0);
    s.setAgents(ids);
    for (const phase of ["initial", "moving", "resized"]) {
      if (phase === "moving") s.tick(240);
      if (phase === "resized") s.resize(375, 650);
      for (let i = 0; i < ids.length - 1; i++) expectOnGuide("worker-" + i, i < 6 ? 0 : 1);
    }
    s.setAgents(["abot", "worker-0"]);
    expectOnGuide("worker-0", 0);
    expect(s.guides[1]!.hidden).toBe(true);
  });

  test.each([375, 1150])("an orbiting satellite grows toward the viewer while ABot stays fixed at width %i", width => {
    const near = agentOrbitPoint(1, 3, 450, width, 700);
    const far = agentOrbitPoint(1, 3, 0, width, 700);
    expect(near.y).toBeGreaterThan(far.y);
    expect(near.size).toBeGreaterThan(far.size * 1.2);
    for (let time = 0; time <= 900; time += 5) {
      const point = agentOrbitPoint(1, 3, time, width, 700);
      expect(point.size).toBeGreaterThanOrEqual(44);
    }
    expect(agentOrbitPoint(0, 3, 450, width, 700)).toEqual(agentOrbitPoint(0, 3, 0, width, 700));
  });

  test("agents from opposite depths reach the same conversation size and regain their own size on return", () => {
    const s = scene(1150, 800, 240, true);
    const sizes = ["scout", "builder"].map(id => {
      const node = s.node(id), resting = node.offsetHeight;
      s.select(id);
      const focused = node.offsetHeight * node.scale();
      s.select("");
      expect(node.offsetHeight * node.scale()).toBeCloseTo(resting, 2);
      return { resting, focused };
    });
    expect(sizes[1]!.resting).toBeGreaterThan(sizes[0]!.resting);
    expect(sizes[1]!.focused).toBeCloseTo(sizes[0]!.focused, 2);
  });
});


describe("independent floating orbit targets", () => {
  test("settled floating windows stop animation frames and closing resumes orbit motion", () => {
    const s = scene(1150, 800, 240);
    s.motion.setWindowTarget("scout", { x: 300, y: 110, size: 74, scale: 1.15 });
    s.tick(30);
    expect(s.framePending()).toBe(false);
    s.motion.setWindowTarget("scout", null);
    expect(s.framePending()).toBe(true);
    s.tick(30);
    expect(s.framePending()).toBe(true);
    const before = s.node("scout").coordinate("x");
    s.tick(10);
    expect(s.node("scout").coordinate("x")).not.toBe(before);
  });
  test.each([false, true])("independent approach and return (reduced: %s)", reduced => {
    const s = scene(1150, 800, 240, reduced);
    const scout = s.node("scout"), builder = s.node("builder");
    const initial = scout.coordinate("x");
    s.motion.setWindowTarget("scout", { x: 300, y: 110, size: 74, scale: 1.15 });
    s.motion.setWindowTarget("builder", { x: 800, y: 130, size: 74, scale: 1.15 });
    if (!reduced) { s.tick(10); expect(scout.coordinate("x")).not.toBe(initial); expect(scout.coordinate("x")).not.toBe(300); }
    s.tick(24);
    expect(scout.coordinate("x")).toBe(300);
    expect(builder.coordinate("x")).toBe(800);
    expect(scout.scale()).toBeCloseTo(1.15);
    for (const id of ["abot", "scout", "builder"]) { expect(s.node(id).inert).toBe(false); expect(s.node(id).style.visibility).toBe(""); expect(s.node(id).style.opacity).toBe("1"); }
    s.motion.setWindowTarget("scout", null); s.tick(24);
    expect(scout.scale()).toBe(1);
    expect(Math.abs(scout.coordinate("x") - initial)).toBeLessThan(2);
    expect(builder.coordinate("x")).toBe(800);
    s.motion.setWindowTarget("builder", { x: 650, y: 160, size: 74, scale: 1.15 });
    expect(builder.coordinate("x")).toBe(650);
  });
  test.each([[375,650,375,404],[1150,800,520,600],[320,400,320,244]])("bounded agent-relative placement %i x %i", (width,height,pw,ph) => {
    for (const x of [0,width/2,width]) {
      const p = agentWindowPlacement({x,y:height/2},width,height,pw,ph);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x+pw).toBeLessThanOrEqual(width);
      expect(p.y).toBeGreaterThanOrEqual(Math.min(180,height*.36)); expect(p.y+ph).toBeLessThanOrEqual(height);
    }
  });
});
