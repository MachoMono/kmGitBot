'use strict';
// Twig's XP, levels and growth stages. Pure functions over the store's `mascot` object.

const XP = {
  save: 10,
  push: 15,
  pull: 5,
  undo: 10,
  restore: 10,
  init: 20,
  rescue: 30,
  githubHome: 25,
  lesson: 5,
};
const FIRST_TIME_BONUS = 25;
const SAVES_PER_HOUR_THAT_COUNT = 6;

const FIRST_BADGES = {
  save: 'First save point!',
  push: 'First online backup!',
  pull: 'First time getting the latest!',
  undo: 'First undo!',
  restore: 'First file brought back!',
  init: 'First project planted!',
  rescue: 'First rescue!',
  githubHome: 'First GitHub home!',
};

const STAGES = [
  { id: 'seed', name: 'Seed', from: 1 },
  { id: 'sprout', name: 'Sprout', from: 2 },
  { id: 'sapling', name: 'Sapling', from: 4 },
  { id: 'young', name: 'Young Tree', from: 7 },
  { id: 'oak', name: 'Grand Oak', from: 11 },
];

const TITLES = ['Curious Seed', 'Tiny Sprout', 'Busy Sprout', 'Saver Sapling', 'Steady Sapling', 'Backup Buddy',
  'Branch Scout', 'Time Traveller', 'Root Keeper', 'Commit Captain', 'Grand Oak', 'Forest Friend'];

// Total XP needed to *reach* a level: L1=0, L2=50, L3=150, L4=300, L5=500 …
function xpToReach(level) {
  return 50 * (level - 1) * level / 2;
}

function levelFor(xp) {
  let level = 1;
  while (xp >= xpToReach(level + 1)) level++;
  return level;
}

function stageFor(level) {
  let stage = STAGES[0];
  for (const s of STAGES) if (level >= s.from) stage = s;
  return stage;
}

function titleFor(level) {
  return TITLES[Math.min(level, TITLES.length) - 1];
}

function snapshot(m) {
  const level = levelFor(m.xp);
  const floor = xpToReach(level);
  const next = xpToReach(level + 1);
  return {
    xp: m.xp,
    level,
    title: titleFor(level),
    stage: stageFor(level),
    progress: (m.xp - floor) / (next - floor),
    toNext: next - m.xp,
  };
}

// Mutates m. Returns what happened so the UI can celebrate.
function award(m, action, now = Date.now()) {
  if (!(action in XP)) throw new Error(`unknown action ${action}`);
  const before = snapshot(m);
  let gained = XP[action];
  if (action === 'save') {
    m.saveTimes = (m.saveTimes || []).filter((t) => now - t < 3600 * 1000);
    if (m.saveTimes.length >= SAVES_PER_HOUR_THAT_COUNT) gained = 0; // no reward for spam-saving
    else m.saveTimes.push(now);
  }
  let badge = null;
  m.firsts = m.firsts || {};
  if (FIRST_BADGES[action] && !m.firsts[action]) {
    m.firsts[action] = now;
    gained += FIRST_TIME_BONUS;
    badge = FIRST_BADGES[action];
  }
  m.xp += gained;
  const after = snapshot(m);
  return {
    gained,
    badge,
    levelUp: after.level > before.level,
    stageUp: after.stage.id !== before.stage.id,
    ...after,
  };
}

module.exports = { award, snapshot, levelFor, xpToReach, stageFor, STAGES, XP, FIRST_TIME_BONUS, SAVES_PER_HOUR_THAT_COUNT };
