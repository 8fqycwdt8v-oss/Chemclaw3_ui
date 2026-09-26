/**
 * The durable-run registry, and the honesty of its one destructive control.
 *
 * Two things are worth pinning here and neither is the list.
 *
 * **The rationale is the product.** `job_records` keeps why each run was launched, and that is
 * what makes a six-week-old calculation findable at all — a job id tells a reader nothing. The
 * search covers it, so the empty state has to say so, or a chemist searching for a *result* reads
 * "no run matches that" as "we never ran it".
 *
 * **Cancellation is a request, not an outcome.** The service answers 202 and a workflow already
 * past its last cancellation point finishes anyway, so nothing in this UI may say the job stopped.
 *
 * **And a read that failed has to stop looking like a read that is still going.** The sheet set
 * `status` to `null` on the way in and, on failure, wrote only the notice — so its spinner's
 * `!status` guard stayed true for the life of the sheet. A chemist got an error string with a
 * spinner turning under it, permanently, and no way to retry: the only other control in the sheet
 * is the close button. Its three sibling sheets all guard their spinner on a failed state, which
 * is what makes this an oversight rather than a house style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { JobsPanel } from '../src/components/JobsPanel.tsx';
import { stubFetch } from './helpers.ts';
import type { DurableJobStatus, JobRecordSummary } from '../src/api/client.ts';

const mode = { current: 'dev' as 'dev' | 'msal', roles: [] as string[] };

vi.mock('../src/auth/AuthContext.tsx', async () => {
  const { config } = await import('../src/env.ts');
  const auth = {
    getAccessToken: async () => null,
    get mode() {
      return mode.current;
    },
    get account() {
      return { id: 'u', username: 'u', name: 'u', roles: mode.roles };
    },
  };
  const value = { auth, ready: true, revision: 0 };
  return {
    useAuth: () => value,
    useIsReviewer: () =>
      mode.current === 'dev' || config.reviewerRoles.some((r) => mode.roles.includes(r)),
  };
});

/**
 * Annotated with the interface the service's route is declared to return, not left as a bare
 * literal. Zero runtime cost, and it makes `tsc -b` — already a CI step — the drift check: a field
 * renamed or added on `JobRecordSummary` now fails the typecheck here instead of leaving this
 * fixture describing a shape the real service stopped sending. `e2e/fixture-service.ts`'s own
 * comment records that exact failure having happened once, to `GET /sessions`.
 */
const RECORD: JobRecordSummary = {
  job_id: 'calc-9f2c',
  connector: 'calc',
  job: 'compare_solvents',
  rationale: 'Decide whether 2-MeTHF or CPME favours the coupling.',
  summary: '4 solvents ranked by ΔG.',
  note_id: '',
  plan_step: '',
  state: 'completed',
  completed_at: '2026-08-01T09:00:00Z',
};

const STATUS: DurableJobStatus = {
  job_id: 'calc-9f2c',
  status: 'running',
  summary: null,
  result: {},
  rationale: RECORD.rationale,
  calc_refs: [],
};

let restore: (() => void) | null = null;
const deletes: string[] = [];
let searched = '';
/** The `after` cursors this panel asked for, in order — empty string for the first page. */
const pagesAsked: string[] = [];
/** What the registry advertises as the next cursor, per `after` it was asked with. */
let cursors: Record<string, string> = {};

/** How many times the job read has been asked for, and whether it is currently failing. */
let jobReads = 0;
let jobReadFails = false;

function serve(records = [RECORD], status: DurableJobStatus = STATUS): void {
  const stub = stubFetch((url, init) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      // 202 with a body, as the service answers — cancellation is accepted, not performed.
      return new Response(JSON.stringify({ status: 'cancelling', job_id: 'calc-9f2c' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/jobs/')) {
      jobReads += 1;
      if (jobReadFails) {
        return new Response(JSON.stringify({ detail: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const query = new URL(url, 'http://x').searchParams;
    searched = query.get('text') ?? '';
    const after = query.get('after') ?? '';
    pagesAsked.push(after);
    const next = cursors[after] ?? '';
    return new Response(JSON.stringify(searched ? [] : records.filter((r) => r.job_id !== after)), {
      status: 200,
      // The registry advertises the cursor only when the store saw a further row.
      headers: { 'content-type': 'application/json', ...(next ? { 'x-next-cursor': next } : {}) },
    });
  });
  restore = stub.restore;
}

beforeEach(() => {
  cleanup();
  deletes.length = 0;
  searched = '';
  pagesAsked.length = 0;
  cursors = {};
  jobReads = 0;
  jobReadFails = false;
  mode.current = 'dev';
  mode.roles = [];
});
afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

/**
 * The panel under its real routes, because what is open is now the URL and only the URL.
 *
 * A bare `MemoryRouter` gives `useParams()` an empty object, so a panel that reads what is open
 * off the path opens nothing in one — which is not a defect in the panel, it is this harness
 * declaring a route the app declares too. Both paths are here so a click can navigate.
 */
function mountJobs(at = '/jobs'): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/jobs" element={<JobsPanel />} />
        <Route path="/jobs/:jobId" element={<JobsPanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JobsPanel', () => {
  it('stops the spinner when the LIST read failed, and says it could not ask', async () => {
    // The list, not the sheet — the case further down covers the sheet, and this panel had no case
    // for this one at all. That gap is what let a regression through: `data` on a failed query is
    // `undefined`, and defaulting it to `null` means "still reading", so a 500 left "Reading the
    // registry…" on screen for ever. "Still loading" and "this failed and will never load" being
    // the same screen is exactly what the sheet's own case exists to prevent, one component out.
    //
    // And not as an empty list either: `pageJobs` already folds the one benign case (a 404) into
    // an empty page, so a failure reaching the panel is a real one, and "No runs recorded yet"
    // during a 500 told a chemist their run did not exist.
    restore?.();
    const stub = stubFetch(
      () =>
        new Response(JSON.stringify({ detail: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    restore = stub.restore;

    mountJobs();

    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not search the registry/);
    expect(screen.queryByText('No runs recorded yet')).toBeNull();
    expect(screen.queryByText('Reading the registry…')).toBeNull();
  });

  it('retries a failed first read from the alert, since nothing else would', async () => {
    // The client never retries on its own and resubmitting the same search leaves the query key
    // unchanged, so the alert's "try again" needs a control that actually asks again.
    restore?.();
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ detail: 'bad gateway' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([RECORD]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    restore = stub.restore;
    mountJobs();

    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not search the registry/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('compare_solvents')).toBeTruthy();
    expect(calls).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says an older page failed beside the control that fetches it', async () => {
    restore?.();
    let calls = 0;
    const stub = stubFetch((url) => {
      calls += 1;
      if (url.includes('after=')) {
        return new Response(JSON.stringify({ detail: 'boom' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([RECORD]), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-next-cursor': 'cursor-2' },
      });
    });
    restore = stub.restore;
    mountJobs();

    fireEvent.click(await screen.findByRole('button', { name: /Load older runs/ }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load older runs/);
    // The first page is still shown: it is still true.
    expect(screen.getByText('compare_solvents')).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('leads with why a run happened, not with its id', async () => {
    serve();
    mountJobs();

    expect(
      await screen.findByText('Decide whether 2-MeTHF or CPME favours the coupling.'),
    ).toBeTruthy();
    expect(screen.getByText('compare_solvents')).toBeTruthy();
  });

  it('searches the rationale, and says that is what it searched', async () => {
    // Otherwise a chemist searching for a result reads "no run matches that" as "we never ran it".
    serve();
    mountJobs();
    await screen.findByText('compare_solvents');

    fireEvent.change(screen.getByLabelText('Search runs'), { target: { value: 'nitration' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(searched).toBe('nitration'));
    expect(await screen.findByText(/No run matches that/)).toBeTruthy();
    expect(screen.getByText(/rationale recorded when each run was launched/)).toBeTruthy();
  });

  it('asks for cancellation without claiming the job stopped', async () => {
    serve();
    mountJobs();
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));
    await screen.findByText('running');

    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request cancellation' }));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toContain('/jobs/calc-9f2c');
    // The wording the service's 202 actually supports.
    expect(await screen.findByText(/will still finish/)).toBeTruthy();
  });

  it('does not offer cancellation to someone without the role', async () => {
    mode.current = 'msal';
    mode.roles = [];
    serve();
    mountJobs();
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));
    await screen.findByText('running');

    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
    expect(screen.getByText(/needs a reviewer role/)).toBeTruthy();
  });

  it('stops the spinner when the read failed, and offers the retry', async () => {
    // Otherwise "still loading" and "this failed and will never load" are the same screen.
    jobReadFails = true;
    serve();
    mountJobs();
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));

    await screen.findByRole('status');
    await waitFor(() => expect(screen.queryByText('Reading the job…')).toBeNull());

    jobReadFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('running')).toBeTruthy();
    expect(jobReads).toBe(2);
  });

  it('tells a multi-hour campaign apart from a calculation, in the list and in the sheet', async () => {
    // Every row here is a durable job, so "durable" separates none of them. A campaign is a *loop* —
    // it proposes, evaluates and repeats for as many rounds as its spec asked for — so it runs for
    // hours where a conformer search runs for minutes, and it rendered identically to one.
    const campaign: JobRecordSummary = {
      job_id: 'bo-7c31',
      connector: 'bo',
      job: 'start_optimization_campaign',
      rationale: 'Push the amination past 85% without losing selectivity.',
      summary: '12 rounds, best 88.1%.',
      note_id: 'bo-candidate-7c31',
      plan_step: '',
      state: 'completed',
      completed_at: null,
    };
    serve([campaign, RECORD]);
    mountJobs();

    // The badge is in the list, where a reader is scanning rows.
    const row = await screen.findByRole('button', { name: /start_optimization_campaign/ });
    expect(within(row).getByText('campaign')).toBeTruthy();
    // And the calculation beside it does not get one, which is what makes the badge mean something.
    const calc = screen.getByRole('button', { name: /compare_solvents/ });
    expect(within(calc).queryByText('campaign')).toBeNull();

    // The sentence explaining what a campaign *is* belongs in the sheet: read once, rather than
    // repeated down every row of a search result.
    fireEvent.click(row);
    expect(await screen.findByText('optimisation campaign')).toBeTruthy();
    expect(screen.getByText(/hours rather than the minutes/)).toBeTruthy();
  });

  it('says a failed run failed, instead of rendering it as one more finished job', async () => {
    // `job_records.state` exists for exactly this row: a failing job raises before
    // `ConnectorJobWorkflow._finish`, so a failure used to write no row at all, and the column that
    // fixed that is the one this list has to read. Without it a failed run sits in the registry
    // beside the successful ones with an empty summary and nothing saying it failed — which the
    // service's own model calls "a worse answer than the one that omitted it" — and both rows say
    // *finished*, which is a claim about the run rather than about the clock.
    const failed: JobRecordSummary = {
      ...RECORD,
      job_id: 'calc-1b40',
      job: 'search_conformers',
      rationale: 'Get the accessible conformers before the scan.',
      summary: '',
      state: 'failed',
    };
    serve([failed, { ...RECORD, summary: '' }]);
    mountJobs();

    const row = await screen.findByRole('button', { name: /search_conformers/ });
    expect(within(row).getByText('failed')).toBeTruthy();
    expect(within(row).queryByText(/^finished/)).toBeNull();
    // The successful run beside it carries no state badge at all, which is what makes one mean
    // something: every row in a registry of finished work would otherwise wear the same word.
    const completed = screen.getByRole('button', { name: /compare_solvents/ });
    expect(within(completed).queryByText('failed')).toBeNull();
    expect(within(completed).queryByText('completed')).toBeNull();
    expect(within(completed).getByText(/^finished/)).toBeTruthy();
  });

  it('says which plan step a run served, as the live trace already does', async () => {
    // The service puts the step in the *listing* so "which step was this for" needs no second
    // lookup, and the live trace badges it — so a reloaded or searched-for run losing it is the
    // same fact rendered two ways in one app.
    serve([{ ...RECORD, plan_step: 'Estimate the pKa of the aniline' }]);
    mountJobs();

    const row = await screen.findByRole('button', { name: /compare_solvents/ });
    expect(within(row).getByText(/Estimate the pKa of the aniline/)).toBeTruthy();
  });

  it('names the calculations a run rested on', async () => {
    // `calc_refs` is what `record_knowledge_note` takes, and the reason a note drafted from a
    // calculation the agent had just run could not cite it. They are a sibling of the result
    // envelope rather than part of it, so the `Result` dump below does not carry them.
    serve([RECORD], {
      ...STATUS,
      status: 'completed',
      calc_refs: ['xtb:9ac1f0', 'crest:41b2c7'],
    });
    mountJobs();
    fireEvent.click(await screen.findByRole('button', { name: /compare_solvents/ }));
    await screen.findByText('completed');

    expect(screen.getByText(/xtb:9ac1f0/)).toBeTruthy();
    expect(screen.getByText(/crest:41b2c7/)).toBeTruthy();
  });

  it('offers the older runs the search cap cut off, and follows the cursor', async () => {
    // `job_record_search_limit` is 20 in the shipped config and the service advertises
    // `X-Next-Cursor` when it saw a row beyond the page. Nothing read it, so run 21 was not below a
    // fold — it was never fetched, and the listing looked complete, on the one panel whose purpose
    // is not paying twice for a run that already happened.
    const older: JobRecordSummary = {
      ...RECORD,
      job_id: 'calc-0001',
      job: 'search_conformers_older',
      rationale: 'The run from three months ago.',
    };
    cursors = { '': RECORD.job_id };
    serve([RECORD, older]);
    mountJobs();
    await screen.findByText('compare_solvents');

    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }));

    expect(await screen.findByText('search_conformers_older')).toBeTruthy();
    // The cursor the service advertised, sent back as `after` — not a page number of our own.
    expect(pagesAsked).toEqual(['', RECORD.job_id]);
  });

  it('offers nothing further when the registry advertised no cursor', async () => {
    // The control has to be absent rather than disabled: a button that says there may be more when
    // the service said there is not is the same false completeness inverted.
    serve();
    mountJobs();
    await screen.findByText('compare_solvents');

    expect(screen.queryByRole('button', { name: 'Load older runs' })).toBeNull();
  });

  it('renders a service that sends none of the three new fields', async () => {
    // The older-service direction, which is the same defect class as the note sheet's
    // `confidence: null`: `state` and `plan_step` are absent rather than empty from a service that
    // predates them, and `calc_refs` likewise — so a badge rendered off `!== 'completed'` prints an
    // empty pill and `calc_refs.length` throws inside the sheet.
    serve(
      [
        {
          ...RECORD,
          state: undefined as unknown as string,
          plan_step: undefined as unknown as string,
        },
      ],
      { ...STATUS, calc_refs: undefined as unknown as string[] },
    );
    mountJobs();

    const row = await screen.findByRole('button', { name: /compare_solvents/ });
    // One badge — the connector — and no empty pill beside it: `!== 'completed'` is true of
    // `undefined`, so a badge keyed on inequality renders a bordered blank.
    expect(within(row).getByText(/^finished/)).toBeTruthy();
    const badges = [...row.querySelectorAll('[data-slot="badge"]')];
    expect(badges.map((b) => b.textContent)).toEqual(['calc']);

    fireEvent.click(row);
    expect(await screen.findByText('running')).toBeTruthy();
    expect(screen.queryByText('Calculations it rested on')).toBeNull();
  });

  it('distinguishes an empty registry from an empty search', async () => {
    serve([]);
    mountJobs();
    expect(await screen.findByText('No runs recorded yet')).toBeTruthy();
  });
});
