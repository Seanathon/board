import { addItemSkill } from './add-item.js';
import { createBoardSkill } from './create-board.js';
import { importBookmarksSkill } from './import-bookmarks.js';
import { tagSkill } from './tag.js';
import { uploadAssetSkill } from './upload-asset.js';
import { refetchSkill } from './refetch.js';
import { searchSkill } from './search.js';
import { composeBoardSkill } from './compose-board.js';
import { composeCollectionSkill } from './compose-collection.js';
import { generateFieldsSkill } from './generate-fields.js';
import { exportSkill } from './export.js';
import { importDocumentSkill } from './import-document.js';
import { wipeItemsSkill } from './wipe-items.js';
import type { Skill } from './types.js';

// Story 3.1 — the skill registry. A FACTORY (not a module-global Map) so each
// server / test gets a fresh registry holding only its skills — avoiding the
// processors.ts footgun where a shared global leaks skills across test files
// (last-registration-wins). Registration is EXPLICIT at boot (registerAllSkills),
// not via import side-effects (the prototype's order-fragile pattern).

export interface SkillRegistry {
  register(skill: Skill<any, any>): void;
  get(name: string): Skill<any, any> | undefined;
  list(): Skill<any, any>[];
}

export function createRegistry(): SkillRegistry {
  const skills = new Map<string, Skill<any, any>>();
  return {
    register(skill) {
      // Registration-time duplicate guard — the prototype's registerProcessor
      // silently overwrites; we refuse, so a name collision fails loudly at boot.
      if (skills.has(skill.name)) {
        throw new Error(`Skill "${skill.name}" is already registered (duplicate name).`);
      }
      skills.set(skill.name, skill);
    },
    // undefined on miss (NOT throw) — Story 3.2's route owns the 404; a throw here
    // would become a 500.
    get(name) {
      return skills.get(name);
    },
    list() {
      return [...skills.values()];
    },
  };
}

/**
 * Populate a registry with the v1 skills. EXPLICIT boot registration (deterministic,
 * testable) rather than import side-effects. Concrete skills are added by later
 * stories: import-bookmarks (3.3), create-board/add-item/tag (3.4),
 * generate-fields (10.3), compose-board (10.1).
 */
export function registerAllSkills(registry: SkillRegistry): void {
  registry.register(importBookmarksSkill); // Story 3.3
  registry.register(createBoardSkill); // Story 3.4
  registry.register(addItemSkill); // Story 3.4
  registry.register(tagSkill); // Story 3.4
  registry.register(uploadAssetSkill); // Story 6.4
  registry.register(refetchSkill); // Story 7.3
  registry.register(searchSkill); // Story 9.1
  registry.register(composeBoardSkill); // Story 10.1
  registry.register(composeCollectionSkill); // Story 15.2
  registry.register(generateFieldsSkill); // Story 10.3
  registry.register(exportSkill); // Story 17.1
  registry.register(importDocumentSkill); // data portability: the other half of export
  registry.register(wipeItemsSkill); // data portability: "start from a fresh state"
}
