/**
 * An experimental record cited in an answer is a chip a chemist can open.
 *
 * ELN and ORD runs are rows in the service's reaction store, cited as `reaction-<source>.<id>` (or
 * the bare `reaction-<id>`) — core's `kg.note.note_id_for_reaction`, which `gather_evidence` and
 * `similar_reactions` hand the model — and `GET /notes/{id}` resolves both. `remarkCitations` knew
 * no `reaction-` prefix, so the one kind of citation that names an experiment rendered as plain
 * text. Found by the kind full-workflow suite against the whole system.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';

vi.mock('../src/auth/AuthContext.tsx', () => ({
  useAuth: () => ({ auth: { getAccessToken: async () => null, mode: 'dev' }, ready: true }),
}));

const show = (body: string): void => {
  render(<Markdown>{body}</Markdown>);
};

beforeEach(cleanup);

describe('a cited experimental record', () => {
  it('is a chip in its qualified form, sentence punctuation left outside', () => {
    show('The flow run reaction-eln-ord.suzuki-flow-hte-04620. It gave 41 % yield.');

    expect(
      screen.getByRole('button', { name: 'reaction-eln-ord.suzuki-flow-hte-04620' }),
    ).toBeTruthy();
  });

  it('is a chip in its bare form', () => {
    show('See reaction-uspto-amide-coupling-1 and reaction-eln-json.liu-orgsyn-procedure-1.');

    expect(screen.getByRole('button', { name: 'reaction-uspto-amide-coupling-1' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'reaction-eln-json.liu-orgsyn-procedure-1' }),
    ).toBeTruthy();
  });

  it('leaves an English compound that happens to start with "reaction-" as prose', () => {
    show('Launched the reaction-energy job at reaction-level detail; the reaction-time was short.');

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/reaction-energy job/)).toBeTruthy();
  });

  it('is not linkified inside code, where a reaction id is data rather than a citation', () => {
    show('Run `reaction-eln-ord.suzuki-flow-hte-04620` again.');

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
