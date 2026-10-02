/**
 * One artefact as the service serialises it, shared by the artefact test files.
 *
 * In a module of its own rather than exported from a test file: importing a `.test.ts` registers
 * its cases a second time in the importer, which is a suite that runs everything twice and reports
 * it as coverage.
 */

const SID = 'a'.repeat(32);
const XID = 'xb-0123456789abcdef';

/** One `ExhibitView` exactly as the service serialises it (datetimes as ISO strings). */
export const VIEW = {
  exhibit_id: XID,
  session_id: SID,
  kind: 'table',
  title: 'Solvent ranking',
  head_revision: 2,
  head_author_kind: 'human',
  head_author: 'chemist@example.com',
  created_by: 'chemist@example.com',
  created_at: '2026-10-02T14:00:00Z',
  updated_at: '2026-10-02T14:05:00Z',
  revision: 2,
  parent_revision: 1,
  author_kind: 'human',
  author: 'chemist@example.com',
  change_note: 'Corrected the 2-MeTHF yield',
  revision_created_at: '2026-10-02T14:05:00Z',
  spec: {
    kind: 'table',
    columns: [
      { key: 'solvent', label: 'Solvent', unit: '' },
      { key: 'yield', label: 'Yield', unit: '%' },
    ],
    rows: [
      { solvent: '2-MeTHF', yield: 82 },
      { solvent: 'CPME', yield: null },
    ],
  },
  unverified_figures: ['82'],
};
