// ============================================================
//  LOCUS MUTATION POLICY (Product) — M1b repository split
//
//  This file is PRODUCT knowledge, not Runtime: it owns the
//  /home/locus/.skills layout rules that used to be hardcoded inside the
//  shell's mv/rm (src/shell.js, removed in M1b). The generic Runtime shell
//  knows only the OPERATION-AWARE PORT it consumes (contract
//  docs/REPOSITORY-SPLIT-CONTRACTS.md §3.7):
//
//    checkMove({ source, destination, sourceKind?, destinationKind?,
//                recursive })
//      → { allowed: true } | { allowed: false, reason }
//        `destination` is the FINAL target (after the mv-into-directory
//        basename append); `reason` is the user-facing text WITHOUT the
//        command prefix (the shell composes `mv: <src>: <reason>`).
//
//    checkRemove({ target, kind, recursive })
//      → { allowed: true } | { allowed: false, reason }
//        `kind` is 'file' | 'directory' as resolved by the shell; `reason`
//        is user-facing without the `rm: ` prefix.
//
//    isPolicyRefusal(error)
//      → true when a filesystem-provider error came from this policy
//        family (declined confirmation, TOCTOU conflict, undeclared path,
//        size bound). The python commit phase reports these as REFUSED
//        conflicts — honest changeset accounting — instead of generic
//        write failures.
//
//  The generic Runtime may explicitly run with NO policy (neutral shell:
//  plain mv/rm everywhere the VFS allows); the Locus product MUST install
//  this policy — store.js injects it into every bash execution and fails
//  loudly if the policy implementation is unavailable. It is a safety
//  PRESENTATION-layer rule closure, not the only file guard: the VFS
//  read-only/protected-root/path-safety enforcement and the per-file
//  SkillInstanceWorkspace confirmation/diff/TOCTOU guard (mounted on the
//  task fork) remain in force independently, and this policy can never
//  turn those refusals into allowances.
//
//  Refusal texts are BYTE-STABLE contract data (shell/skill-instances
//  suites pin them) — keep them exactly as they were when they lived in
//  shell.js.
// ============================================================

const SKILL_INSTANCE_SHELL_ROOT = '/home/locus/.skills';
const SKILL_IDENTITY_BOUNDARY_MSG =
  'Skill instance paths are stable; edit the skill in place, '
  + 'delete the individual skill with approval, or remove/re-add the capability.';

function underSkillInstances(abs) {
  return abs === SKILL_INSTANCE_SHELL_ROOT || abs.startsWith(SKILL_INSTANCE_SHELL_ROOT + '/');
}

// The two structural holes the per-file guard cannot see, closed at the
// command layer:
//   mv — a move would split the mutation across an approval-bound write
//        and an approval-bound delete; a half-approved half-move is
//        exactly the incoherent state the path identity forbids. ANY move
//        touching the skills tree (source OR final destination) is
//        refused outright — never split into an approved write plus an
//        approved delete.
//   rm on a DIRECTORY under the skills root (recursive or not) —
//        capability-wide deletion is exclusively the user's Remove action
//        in Settings. A single declared <skill>.skill FILE stays on its
//        approval path (the mounted guard asks); this policy never blocks
//        it.
const LOCUS_MUTATION_POLICY = Object.freeze({
  checkMove(args) {
    const a = args || {};
    if (underSkillInstances(a.source) || underSkillInstances(a.destination)) {
      return { allowed: false, reason: SKILL_IDENTITY_BOUNDARY_MSG };
    }
    return { allowed: true };
  },
  checkRemove(args) {
    const a = args || {};
    if (a.kind === 'directory' && underSkillInstances(a.target)) {
      return {
        allowed: false,
        reason: 'refusing to remove capability skill directory: ' + a.target + '. '
          + SKILL_IDENTITY_BOUNDARY_MSG,
      };
    }
    return { allowed: true };
  },
  isPolicyRefusal(error) {
    return !!error && typeof error.code === 'string' && error.code.indexOf('skill_mutation_') === 0;
  },
});

const LocusMutationPolicy = {
  // Product factory: the frozen, stateless policy injected into every
  // bash execution (store.js wiredToolExecutor → opts.mutationPolicy).
  create() {
    return LOCUS_MUTATION_POLICY;
  },
};
