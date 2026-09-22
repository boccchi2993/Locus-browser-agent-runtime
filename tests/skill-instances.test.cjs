// Mutable skill instance closure tests (node):
//   - SkillDefinition = immutable publisher metadata; SkillSourceStore =
//     trusted default Markdown; SkillInstance = capability-private
//     durable working copy (Definitions shared, instances NEVER shared).
//   - Materialization lifecycle: first Add, install marker (written
//     LAST), rollback, reload/re-enable reuse, user-deletion respect,
//     incomplete-install recovery, incompatible-marker fail-loud,
//     Remove = reset boundary.
//   - SkillInstanceWorkspace guard: reads free; every create/write/delete
//     asks via the Approval Framework kind 'confirmation' (no session
//     grants, real diff, TOCTOU re-verification, cancellation).
//   - Shell structural holes: mv involving a skill instance and rm -r of
//     a capability skill directory are refused outright.
// Run: node tests/skill-instances.test.cjs

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const extSrc = ['src/workspace.js', 'src/vfs.js', 'src/extensions.js', 'src/approval.js']
  .map((f) => read(f)).join('\n;\n');
const M = eval(extSrc + '\n;({ CapabilityManager, SkillSourceStore, SkillInstanceStorage,'
  + ' SkillInstanceWorkspace, VirtualWorkspace, MemoryWorkspace, ApprovalController, skillInstancePath });');

// shell bundle for the mv/rm boundary tests (same recipe as shell-compat)
global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };
const shellSrc = ['src/telemetry.js', 'src/workspace.js', 'src/vfs.js', 'src/network.js', 'src/shell.js', 'src/tools.js']
  .map((f) => read(f)).join('\n;\n');
const SH = eval(shellSrc + '\n;({ executeTool, VirtualWorkspace, MemoryWorkspace, SHELL_COMMANDS, GrepRegexRuntime, Telemetry });');
const { installGrepFakeWorker } = require('./helpers/grep-fake-worker.cjs');
installGrepFakeWorker(SH);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 300) : '')); }
}
async function throwsWith(name, fn, codePart, msgPart) {
  try {
    await fn();
    check(name, false, 'expected throw');
  } catch (e) {
    const hay = (e.code || '') + ' ' + e.name + ' ' + e.message;
    const ok = (!codePart || hay.includes(codePart))
      && (!msgPart || hay.includes(msgPart));
    check(name, ok, (e.code || e.name) + ': ' + e.message);
  }
}

const SYNTH_SKILL_BODY = read('tests/fixtures/skills/synthetic-skill/SKILL.md');

const CAPS = () => ({
  capabilities: [
    { id: 'cap-a', version: '1', displayName: 'Capability A', description: 'd', plugins: [], skills: ['synthetic-skill'], mcps: [] },
    { id: 'cap-b', version: '1', displayName: 'Capability B', description: 'd', plugins: [], skills: ['synthetic-skill'], mcps: [] },
    { id: 'cap-plain', version: '1', displayName: 'Plain', description: 'd', plugins: [], skills: [], mcps: [] },
  ],
  skills: [{ id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'd' }],
});

// Deterministic approval driver: resolves the current pending request
// after `delayMs` with the given decision (or cancels it).
function autoDecide(approvals, decisionFn, delayMs) {
  return new Promise((resolve) => {
    const tick = () => {
      const p = approvals.pending;
      if (p) {
        setTimeout(() => {
          const d = decisionFn(p);
          if (d && d.cancel) approvals.cancel(p.id, d.reason || 'test');
          else approvals.resolve(p.id, d);
        }, delayMs || 5);
        resolve(p);
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function rig(opts) {
  const o = opts || {};
  const home = o.home || new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
  const storage = o.storage || new M.SkillInstanceStorage({ resolveHome: () => home });
  const sources = new M.SkillSourceStore();
  if (!o.noSource) sources.define('synthetic-skill', '1', SYNTH_SKILL_BODY);
  const manager = new M.CapabilityManager({
    catalogs: o.catalogs || CAPS(),
    sources: sources,
    instances: o.instances === undefined ? storage : o.instances,
  });
  return { home, storage, sources, manager };
}

function guardFor(manager, storage, taskEnvironment, signalOrNull) {
  const approvals = new M.ApprovalController({});
  let signal = signalOrNull || null;
  const wrapper = new M.SkillInstanceWorkspace({
    storage: storage,
    context: {
      approvals: approvals,
      conversationId: 'conv-1',
      taskGeneration: 0,
      getSignal: () => signal,
      taskEnvironment: taskEnvironment,
    },
  });
  return { approvals, wrapper, setSignal: (s) => { signal = s; } };
}

async function run() {
  // ================= Definition / Instance model =================
  const rig0 = rig();
  check('D1 production-style manager keeps source store and instances separate',
    rig0.manager.skillSources instanceof M.SkillSourceStore
    && rig0.manager.skillInstances instanceof M.SkillInstanceStorage
    && rig0.manager.skillSources.sourceOf('synthetic-skill', '1').text === SYNTH_SKILL_BODY);
  await throwsWith('D2 source store rejects non-text', () => rig0.sources.define('synthetic-skill', '1', null), 'skill source');
  await throwsWith('D3 source store rejects bad id', () => rig0.sources.define('Bad Id', '1', 'x'), 'id must match');
  check('D4 instance identity is capabilityId + skillId (path IS the identity)',
    M.skillInstancePath('cap-a', 'synthetic-skill') === '/home/locus/.skills/cap-a/synthetic-skill.skill');

  // ================= materialization lifecycle =================
  // NOTE: enable() is idempotent on a manager that already holds the
  // capability. Reuse semantics therefore exercise the RELOAD path:
  // a FRESH manager over the same durable home — exactly what a page
  // reload + re-Add does.
  {
    const { home, manager } = rig();
    const state = await manager.enable('cap-a');
    check('L1 first Add materializes the default source byte-for-byte', state === 'ready'
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);
    const markerRaw = await home.read('.skills/cap-a/.locus-installed.json');
    const marker = JSON.parse(markerRaw);
    check('L2 marker records capabilityId/version + per-skill id/version/hash',
      marker.capabilityId === 'cap-a' && marker.capabilityVersion === '1'
      && marker.skills.length === 1 && marker.skills[0].id === 'synthetic-skill'
      && marker.skills[0].sourceVersion === '1' && /^[0-9a-f]{64}$/.test(marker.skills[0].sourceHash), markerRaw);

    // REUSE across a reload: a user edit survives re-Add.
    await home.write('.skills/cap-a/synthetic-skill.skill', '# customized by the user\n');
    const manager2 = rig({ home }).manager;
    const reuse = await manager2.enable('cap-a');
    check('L3 re-enable with compatible marker REUSES the customized instance', reuse === 'ready'
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === '# customized by the user\n');

    // Deliberate user deletion is respected: no silent default restore.
    await home.remove('.skills/cap-a/synthetic-skill.skill');
    const manager3 = rig({ home }).manager;
    const afterDelete = await manager3.enable('cap-a');
    check('L4 user-deleted skill stays deleted (marker present, no recreate)', afterDelete === 'ready'
      && !(await home.exists('.skills/cap-a/synthetic-skill.skill')));
    await manager3.refreshSkillPresence();
    const env = manager3.buildTaskEnvironment();
    check('L4b deleted instance reports present=false and drops from skillPaths',
      env.skills[0].present === false && env.capabilities[0].skillPaths.length === 0
      && env.capabilities[0].skillIds.length === 1);

    // Incomplete install: no marker -> leftovers cleaned, defaults rebuilt.
    await home.write('.skills/cap-a/synthetic-skill.skill', 'half-written garbage');
    await home.remove('.skills/cap-a/.locus-installed.json');
    const manager4 = rig({ home }).manager;
    const recovered = await manager4.enable('cap-a');
    check('L5 marker-less install is treated as incomplete: cleaned + rebuilt', recovered === 'ready'
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY
      && await home.exists('.skills/cap-a/.locus-installed.json'));

    // Incompatible marker: never auto-overwrite user skills.
    await home.write('.skills/cap-a/synthetic-skill.skill', 'still the users words');
    marker.capabilityVersion = '2';
    await home.write('.skills/cap-a/.locus-installed.json', JSON.stringify(marker));
    const manager5 = rig({ home }).manager;
    const mismatched = await manager5.enable('cap-a');
    check('L6 capabilityVersion mismatch -> state error, user file untouched', mismatched === 'error'
      && /do not match the current catalog/.test(manager5.listCapabilities().find((c) => c.id === 'cap-a').error)
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'still the users words');

    // Source drift under the same version -> incompatible -> fail loudly.
    const drift = rig();
    await drift.manager.enable('cap-a');
    const driftMarker = JSON.parse(await drift.home.read('.skills/cap-a/.locus-installed.json'));
    driftMarker.skills[0].sourceHash = '0'.repeat(64);
    await drift.home.write('.skills/cap-a/.locus-installed.json', JSON.stringify(driftMarker));
    const manager6 = rig({ home: drift.home }).manager;
    const driftState = await manager6.enable('cap-a');
    check('L7 source hash drift -> state error, no silent overwrite', driftState === 'error'
      && /do not match the current catalog/.test(manager6.listCapabilities().find((c) => c.id === 'cap-a').error)
      && (await drift.home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);
  }
  {
    // Missing default source -> honest error state, nothing materialized.
    const { home, manager } = rig({ noSource: true });
    const state = await manager.enable('cap-a');
    check('L8 skill without a default source -> state error, no files',
      state === 'error' && /no default source/.test(manager.listCapabilities().find((c) => c.id === 'cap-a').error)
      && !(await home.exists('.skills/cap-a/synthetic-skill.skill'))
      && !(await home.exists('.skills/cap-a/.locus-installed.json')));
  }
  {
    // No instance storage at all -> loud error, never a fake enable.
    const { manager } = rig({ instances: null });
    const state = await manager.enable('cap-a');
    check('L9 missing skill instance storage -> state error', state === 'error'
      && /skill instance storage is unavailable/.test(manager.listCapabilities().find((c) => c.id === 'cap-a').error));
    const plain = await manager.enable('cap-plain');
    check('L9b skill-less capability needs no storage', plain === 'ready');
  }
  {
    // Rollback: a mid-install failure leaves NO half-installed state.
    let failAfter = 1; // first write succeeds, second fails
    const flakyHome = new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
    const flaky = new M.SkillInstanceStorage({ resolveHome: () => flakyHome });
    const realWrite = flaky.writeBytes.bind(flaky);
    const realRemoveDir = flaky.removeDir.bind(flaky);
    flaky.writeBytes = async (rel, bytes) => {
      if (failAfter <= 0 && !rel.endsWith('.locus-installed.json')) throw new Error('simulated OPFS fault');
      return realWrite(rel, bytes);
    };
    // marker write also fails -> rollback must clean everything
    flaky.writeBytes = async (rel, bytes) => {
      if (rel.endsWith('.locus-installed.json')) throw new Error('simulated marker fault');
      return realWrite(rel, bytes);
    };
    flaky.removeDir = realRemoveDir;
    const { manager } = rig({ home: flakyHome, storage: flaky });
    const state = await manager.enable('cap-a');
    check('L10 marker-write failure -> error state', state === 'error' && /skill materialization failed/.test(state === 'error'
      ? manager.listCapabilities().find((c) => c.id === 'cap-a').error : ''));
    check('L10b rollback removed the partial install (no files, no marker)',
      !(await flakyHome.exists('.skills/cap-a/synthetic-skill.skill'))
      && !(await flakyHome.exists('.skills/cap-a/.locus-installed.json')));
    // After the fault clears, Remove + Add retries from scratch (the
    // failed entry stays until the user removes it — never half-installed).
    flaky.writeBytes = realWrite;
    await manager.disable('cap-a');
    const retry = await manager.enable('cap-a');
    check('L10c retry after rollback materializes cleanly', retry === 'ready'
      && (await flakyHome.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);
    void failAfter;
  }
  {
    // Remove = reset boundary; disable failure keeps the capability.
    const { home, manager } = rig();
    await manager.enable('cap-a');
    await manager.disable('cap-a');
    check('L11 Remove deletes the whole capability skill directory',
      !(await home.exists('.skills/cap-a')) && manager.capabilityState('cap-a') === 'disabled');
    const readd = await manager.enable('cap-a');
    check('L11b Re-add rematerializes the immutable default (old customization gone)',
      readd === 'ready' && (await home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);

    const brokenHome = new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
    const brokenStorage = new M.SkillInstanceStorage({ resolveHome: () => brokenHome });
    const realRemoveDir = brokenStorage.removeDir.bind(brokenStorage);
    brokenStorage.removeDir = async (rel) => { throw new Error('simulated cleanup fault'); };
    const broken = rig({ home: brokenHome, storage: brokenStorage });
    await broken.manager.enable('cap-a');
    let threw = null;
    try { await broken.manager.disable('cap-a'); } catch (e) { threw = e; }
    check('L12 failed destructive removal throws and keeps the capability enabled',
      !!threw && /was NOT removed/.test(threw.message) && broken.manager.isEnabled('cap-a'),
      threw && threw.message);
    brokenStorage.removeDir = realRemoveDir;
    await broken.manager.disable('cap-a');
    check('L12b Remove succeeds once storage recovers', broken.manager.capabilityState('cap-a') === 'disabled');
    void failAfterGuard;
  }

  // ================= isolation: shared definition, private instances =================
  {
    const { home, manager, storage } = rig();
    await manager.enable('cap-a');
    await manager.enable('cap-b');
    const aBytes = await home.readBytes('.skills/cap-a/synthetic-skill.skill');
    const bBytes = await home.readBytes('.skills/cap-b/synthetic-skill.skill');
    check('I1 first materialization: A and B are byte-identical copies of the definition',
      Buffer.compare(Buffer.from(aBytes), Buffer.from(bBytes)) === 0
      && Buffer.compare(Buffer.from(aBytes), Buffer.from(SYNTH_SKILL_BODY)) === 0);
    const crypto = require('crypto');
    const hashOf = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
    check('I1b SHA-256 equal at first materialization', hashOf(aBytes) === hashOf(bBytes));

    const env = manager.buildTaskEnvironment();
    const g = guardFor(manager, storage, env, new AbortController().signal);
    const p = g.wrapper.write('cap-a/synthetic-skill.skill', '# A was customized\n');
    await autoDecide(g.approvals, () => ({ outcome: 'confirm', scope: 'once' }));
    await p;
    const aAfter = await home.readBytes('.skills/cap-a/synthetic-skill.skill');
    const bAfter = await home.readBytes('.skills/cap-b/synthetic-skill.skill');
    check('I2 approved mutation of A leaves B byte-identical to the default',
      Buffer.compare(Buffer.from(aAfter), Buffer.from(bAfter)) !== 0
      && Buffer.compare(Buffer.from(bAfter), Buffer.from(SYNTH_SKILL_BODY)) === 0
      && Buffer.compare(Buffer.from(aAfter), Buffer.from(SYNTH_SKILL_BODY)) !== 0);
    const env2 = manager.buildTaskEnvironment();
    check('I3 TaskEnvironment carries BOTH instances with independent paths',
      env2.skills.length === 2
      && env2.skills.map((s) => s.path).sort().join('|')
        === '/home/locus/.skills/cap-a/synthetic-skill.skill|/home/locus/.skills/cap-b/synthetic-skill.skill');
  }

  // ================= the guard: reads, confirmations, boundaries =================
  {
    const { home, manager, storage } = rig();
    await manager.enable('cap-a');
    const env = manager.buildTaskEnvironment();
    const g = guardFor(manager, storage, env, new AbortController().signal);

    check('G1 reads are free (read/readBytes/exists/stat/list, no approval, marker hidden)',
      (await g.wrapper.read('cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY
      && !g.approvals.hasPending()
      && (await g.wrapper.exists('cap-a/synthetic-skill.skill'))
      && (await g.wrapper.stat('cap-a/synthetic-skill.skill')).kind === 'file'
      && (await g.wrapper.list('cap-a')).map((e) => e.name).join(',') === 'synthetic-skill.skill');

    // WRITE: card appears with identity + real diff; Cancel keeps bytes.
    const w1 = g.wrapper.write('cap-a/synthetic-skill.skill', SYNTH_SKILL_BODY + '\nadded line\n');
    const req = await autoDecide(g.approvals, () => null, 10); // observe without deciding
    check('G2 write asks via kind confirmation with harness-built identity + diff',
      req && req.kind === 'confirmation' && req.action.type === 'skill-write'
      && req.action.summary.includes('Modify capability guidance')
      && req.action.detail.includes('Capability: Capability A')
      && req.action.detail.includes('Skill: Synthetic Skill')
      && req.action.detail.includes('Path: /home/locus/.skills/cap-a/synthetic-skill.skill')
      && req.action.detail.includes('+ added line')
      && req.resource.key === 'cap-a:synthetic-skill'
      && req.policyKey === null, req && req.action.detail);
    g.approvals.cancel(req.id, 'user dismissed');
    await throwsWith('G3 cancelled confirmation -> declined, bytes unchanged',
      () => w1, 'skill_mutation_declined');
    check('G3b bytes unchanged after cancel', (await home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);

    // CONFIRM applies; the NEXT write asks AGAIN (no session grant).
    const w2 = g.wrapper.write('cap-a/synthetic-skill.skill', SYNTH_SKILL_BODY + '\nadded line\n');
    await autoDecide(g.approvals, () => ({ outcome: 'confirm', scope: 'once' }));
    await w2;
    check('G4 confirmed write lands', (await home.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY + '\nadded line\n');
    const w3 = g.wrapper.write('cap-a/synthetic-skill.skill', 'v3\n');
    const req3 = await autoDecide(g.approvals, () => ({ outcome: 'confirm', scope: 'once' }), 10);
    await w3;
    check('G5 every write asks again — no session grant carryover',
      !!req3 && (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'v3\n');
    // scope=session on a confirmation is rejected by the controller itself.
    const w4 = g.wrapper.write('cap-a/synthetic-skill.skill', 'v4\n');
    await autoDecide(g.approvals, () => null, 10);
    let grantErr = null;
    try { g.approvals.resolve(g.approvals.pending.id, { outcome: 'confirm', scope: 'session' }); } catch (e) { grantErr = e; }
    check('G6 scope=session on a confirmation is rejected (invalid_scope)',
      grantErr && grantErr.code === 'invalid_scope' && g.approvals.pending !== null);
    g.approvals.cancel(g.approvals.pending.id, 'cleanup');
    await throwsWith('G6b the rejected write did not apply', () => w4, 'skill_mutation_declined');
    check('G6c no session grant was created', !g.approvals.hasSessionGrant('cap-a:synthetic-skill'));

    // No-op write: identical bytes -> success without any approval.
    const beforePending = g.approvals.hasPending();
    await g.wrapper.write('cap-a/synthetic-skill.skill', 'v3\n');
    check('G7 identical write is a no-op (no approval, no mutation)',
      !g.approvals.hasPending() && beforePending === false
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'v3\n');

    // CREATE after user deletion: skill-create confirmation; content need
    // not equal the default.
    await home.remove('.skills/cap-a/synthetic-skill.skill');
    const c1 = g.wrapper.write('cap-a/synthetic-skill.skill', '# recreated from scratch\n');
    const creq = await autoDecide(g.approvals, () => ({ outcome: 'confirm', scope: 'once' }), 10);
    await c1;
    check('G8 recreating a deleted declared path asks (skill-create) and lands',
      creq.action.type === 'skill-create' && creq.action.summary.includes('Recreate capability guidance')
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === '# recreated from scratch\n');

    // DELETE: explicit consequence copy; Confirm removes; stays absent.
    const d1 = g.wrapper.remove('cap-a/synthetic-skill.skill');
    const dreq = await autoDecide(g.approvals, () => ({ outcome: 'confirm', scope: 'once' }), 10);
    await d1;
    check('G9 delete asks with consequence copy and lands',
      dreq.action.type === 'skill-delete'
      && dreq.action.detail.includes('It will stay absent until recreated')
      && !(await home.exists('.skills/cap-a/synthetic-skill.skill')));

    // Structural boundaries fail closed WITHOUT any approval request.
    await throwsWith('G10 creating an undeclared skill id is refused', () => g.wrapper.write('cap-a/undeclared.skill', 'x'), 'skill_mutation_boundary');
    await throwsWith('G11 writing the install marker is refused', () => g.wrapper.write('cap-a/.locus-installed.json', '{}'), 'skill_mutation_boundary');
    await throwsWith('G11b deleting the install marker is refused', () => g.wrapper.remove('cap-a/.locus-installed.json'), 'skill_mutation_boundary');
    await throwsWith('G12 mkdir under .skills is refused', () => g.wrapper.mkdir('cap-zzz'), 'skill_mutation_boundary');
    await throwsWith('G13 removing a capability directory is refused', () => g.wrapper.remove('cap-a'), 'skill_mutation_boundary');
    await throwsWith('G14 writing a non-skill file under .skills is refused', () => g.wrapper.write('cap-a/notes.txt', 'x'), 'skill_mutation_boundary');
    check('G15 boundary refusals never opened an approval', !g.approvals.hasPending());

    // Only skills of capabilities in THIS TaskEnvironment are mutable.
    const envAOnly = (() => {
      const e = manager.buildTaskEnvironment();
      void e;
      return manager.buildTaskEnvironment();
    })();
    const gOld = guardFor(manager, storage, (() => {
      // simulate a task whose snapshot predates cap-b's enable
      const m2 = new M.CapabilityManager({
        catalogs: { capabilities: [CAPS().capabilities[0]], skills: CAPS().skills },
        sources: rig().sources,
        instances: storage,
      });
      void m2;
      return {
        capabilities: [envAOnly.capabilities.find((c) => c.id === 'cap-a')],
        skills: envAOnly.skills.filter((s) => s.capabilityId === 'cap-a'),
        plugins: [], mcps: [],
      };
    })(), new AbortController().signal);
    await manager.enable('cap-b');
    await throwsWith('G16 a skill outside the task snapshot is refused (old task cannot touch new capability)',
      () => gOld.wrapper.write('cap-b/synthetic-skill.skill', 'x'), 'skill_mutation_boundary');

    // No live signal -> fail closed.
    const gNoSig = guardFor(manager, storage, manager.buildTaskEnvironment(), null);
    await throwsWith('G17 mutation without a live task signal fails closed',
      () => gNoSig.wrapper.write('cap-a/synthetic-skill.skill', 'x'), 'skill_mutation_no_task');
  }

  // ================= TOCTOU + cancellation + bounds =================
  {
    const { home, manager, storage } = rig();
    await manager.enable('cap-a');
    const env = manager.buildTaskEnvironment();

    // T1 write: underlying bytes change while approval is pending.
    const gW = guardFor(manager, storage, env, new AbortController().signal);
    const tw = gW.wrapper.write('cap-a/synthetic-skill.skill', 'approved content\n');
    await autoDecide(gW.approvals, () => null, 10);
    await home.write('.skills/cap-a/synthetic-skill.skill', 'tampered during review\n');
    gW.approvals.resolve(gW.approvals.pending.id, { outcome: 'confirm', scope: 'once' });
    await throwsWith('T1 changed during approval: write refused as conflict', () => tw, 'skill_mutation_conflict');
    check('T1b the approved diff never landed on the changed file',
      (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'tampered during review\n');

    // T2 delete: same re-verification.
    const gD = guardFor(manager, storage, env, new AbortController().signal);
    const td = gD.wrapper.remove('cap-a/synthetic-skill.skill');
    await autoDecide(gD.approvals, () => null, 10);
    await home.write('.skills/cap-a/synthetic-skill.skill', 'different bytes now\n');
    gD.approvals.resolve(gD.approvals.pending.id, { outcome: 'confirm', scope: 'once' });
    await throwsWith('T2 changed during approval: delete refused as conflict', () => td, 'skill_mutation_conflict');
    check('T2b file survives the refused delete', await home.exists('.skills/cap-a/synthetic-skill.skill'));

    // T3 create: a file appearing during approval blocks the create.
    const gC = guardFor(manager, storage, env, new AbortController().signal);
    await home.remove('.skills/cap-a/synthetic-skill.skill');
    const tc = gC.wrapper.write('cap-a/synthetic-skill.skill', 'created content\n');
    await autoDecide(gC.approvals, () => null, 10);
    await home.write('.skills/cap-a/synthetic-skill.skill', 'appeared during review\n');
    gC.approvals.resolve(gC.approvals.pending.id, { outcome: 'confirm', scope: 'once' });
    await throwsWith('T3 create raced an appearing file -> conflict', () => tc, 'skill_mutation_conflict');
    check('T3b the raced file was not clobbered',
      (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'appeared during review\n');

    // T4 task cancel while pending: no write, decision reports cancelled.
    const ac = new AbortController();
    const gX = guardFor(manager, storage, env, ac.signal);
    const tx = gX.wrapper.write('cap-a/synthetic-skill.skill', 'cancelled content\n');
    await autoDecide(gX.approvals, () => null, 10);
    ac.abort(); // the task's AbortSignal also resolves the pending request
    await throwsWith('T4 task cancellation cancels the confirmation, nothing written',
      () => tx, 'skill_mutation_declined');
    check('T4b bytes untouched by the cancelled task',
      (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'appeared during review\n');

    // T5 abort AFTER confirmation but BEFORE the side effect: slow re-read
    // seam aborts the signal; the guard re-checks and refuses.
    const ac2 = new AbortController();
    const slowHome = new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
    await slowHome.write('.skills/cap-a/synthetic-skill.skill', SYNTH_SKILL_BODY);
    const slowStorage = new M.SkillInstanceStorage({ resolveHome: () => slowHome });
    const realRead = slowStorage.readBytes.bind(slowStorage);
    let armed = false;
    slowStorage.readBytes = async (rel) => {
      const out = await realRead(rel);
      if (armed) { armed = false; ac2.abort(); } // fires on the post-decision re-read
      return out;
    };
    const gY = guardFor(manager, slowStorage, env, ac2.signal);
    const ty = gY.wrapper.write('cap-a/synthetic-skill.skill', 'lost race content\n');
    await autoDecide(gY.approvals, () => null, 10);
    armed = true; // the post-decision re-read will abort the signal
    gY.approvals.resolve(gY.approvals.pending.id, { outcome: 'confirm', scope: 'once' });
    await throwsWith('T5 abort between confirmation and side effect -> no write',
      () => ty, 'skill_mutation_cancelled');
    check('T5b the file kept its pre-approval bytes',
      (await slowHome.read('.skills/cap-a/synthetic-skill.skill')) === SYNTH_SKILL_BODY);

    // Bounds: oversized files and oversized diffs fail closed.
    const gB = guardFor(manager, storage, env, new AbortController().signal);
    await throwsWith('B1 skill over 256 KiB is rejected before any approval',
      () => gB.wrapper.write('cap-a/synthetic-skill.skill', 'x'.repeat(256 * 1024 + 1)), 'skill_mutation_too_large');
    await throwsWith('B2 diff over the review bound fails closed (no partial approval)',
      () => gB.wrapper.write('cap-a/synthetic-skill.skill', SYNTH_SKILL_BODY + 'y'.repeat(21000)), 'skill_mutation_too_large');
    await throwsWith('B3 binary (non-UTF-8) skill bytes are rejected',
      () => gB.wrapper.write('cap-a/synthetic-skill.skill', new Uint8Array([0xff, 0xfe, 0x00, 0x01])), 'skill_mutation_boundary');
    check('B4 bound rejections never opened an approval and never mutated',
      !gB.approvals.hasPending()
      && (await home.read('.skills/cap-a/synthetic-skill.skill')) === 'appeared during review\n');
  }

  // ================= shell structural holes (mv / rm -r) =================
  {
    const home = new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
    const storage = new M.SkillInstanceStorage({ resolveHome: () => home });
    const sources = new M.SkillSourceStore();
    sources.define('synthetic-skill', '1', SYNTH_SKILL_BODY);
    const manager = new M.CapabilityManager({ catalogs: CAPS(), sources, instances: storage });
    await manager.enable('cap-a');
    await manager.refreshSkillPresence();
    const env = manager.buildTaskEnvironment();

    // A task fork with the guarded mount + a live signal, like store.js builds.
    const approvals = new M.ApprovalController({});
    const ac = new AbortController();
    const taskVfs = new SH.VirtualWorkspace({ listCommands: () => Object.keys(SH.SHELL_COMMANDS) });
    taskVfs.mount('/home/locus', home, 'read-write');
    taskVfs.mount('/home/locus/.skills', new M.SkillInstanceWorkspace({
      storage: storage,
      context: {
        approvals: approvals,
        conversationId: 'conv-1',
        taskGeneration: 0,
        getSignal: () => ac.signal,
        taskEnvironment: env,
      },
    }), 'read-write');
    const run = (cmd) => SH.executeTool('bash', cmd, taskVfs, { signal: ac.signal });

    const mv1 = await run('mv /home/locus/.skills/cap-a/synthetic-skill.skill /home/locus/renamed.skill');
    check('S1 mv of a skill instance is refused with the identity contract',
      !mv1.success && mv1.output.includes('Skill instance paths are stable'), mv1.output);
    check('S1b nothing was moved or deleted', await home.exists('.skills/cap-a/synthetic-skill.skill')
      && !(await home.exists('renamed.skill')));

    const mv2 = await run('mv /home/locus/notes.txt /home/locus/.skills/cap-a/incoming.skill');
    check('S2 mv INTO the skills tree is refused', !mv2.success && mv2.output.includes('Skill instance paths are stable'), mv2.output);

    const rm1 = await run('rm -r /home/locus/.skills/cap-a');
    check('S3 rm -r of a capability skill directory is refused', !rm1.success && rm1.output.includes('refusing to remove capability skill directory'), rm1.output);
    check('S3b the directory survived with its files', await home.exists('.skills/cap-a/synthetic-skill.skill'));

    const rm2 = await run('rm -r /home/locus/.skills');
    check('S4 rm -r of the skills root is refused', !rm2.success && rm2.output.includes('refusing to remove capability skill directory'), rm2.output);

    // A single declared skill file still deletes — through the guard.
    const rm3run = run('rm /home/locus/.skills/cap-a/synthetic-skill.skill');
    const dreq = await autoDecide(approvals, () => ({ outcome: 'confirm', scope: 'once' }), 10);
    const rm3 = await rm3run;
    check('S5 rm of ONE declared skill goes through the confirmation guard',
      rm3.success && dreq.kind === 'confirmation' && dreq.action.type === 'skill-delete'
      && !(await home.exists('.skills/cap-a/synthetic-skill.skill')), rm3.output);

    // echo redirect write path hits the same guard (the file was deleted
    // in S5, so this round-trips as a skill-create).
    const echoRun = run('echo hello-guidance > /home/locus/.skills/cap-a/synthetic-skill.skill');
    const wreq = await autoDecide(approvals, () => ({ outcome: 'confirm', scope: 'once' }), 10);
    const echoRes = await echoRun;
    check('S6 echo redirect into a declared skill asks and lands on Confirm',
      echoRes.success && wreq.action.type === 'skill-create'
      && (await home.read('.skills/cap-a/synthetic-skill.skill')).includes('hello-guidance'), echoRes.output);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

let failAfterGuard; void failAfterGuard;
run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
