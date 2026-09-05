/**
 * The announcement effect runs when the activity changes, not once per animation frame.
 *
 * `turnActivity` builds a fresh object every call — deliberately, and rightly: it is a pure
 * derivation over the message rather than a second copy of the store kept in step by hand. But an
 * object in a dependency list is compared by identity, so `[streaming, activity]` never matched
 * itself, and this row re-renders once per animation frame while tokens arrive
 * (`updateAssistant` replaces the messages array every frame). Measured over 121 renders of one
 * streaming turn, the effect ran **121 times and announced twice**; it now runs twice and announces
 * the same twice.
 *
 * Depending on `activity.kind` alone was not available: the body builds its sentence out of the
 * rest of the activity, which is the stale closure `react-hooks/exhaustive-deps` exists to catch.
 * So the sentence is derived in render — a switch and a template string — and the effect depends on
 * the two strings it uses. The first test below pins that mechanism and is the one that fails
 * without the change (before it, `describeActivity` ran once in an effect rather than once per
 * render). The rest pin the behaviour the change is not allowed to alter, and pass either way:
 * announcing on the KIND changing, never on the label, and never on a settled turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ActivityRow } from '../src/components/ActivityLine.tsx';
import { registerAnnouncer } from '../src/state/announce.ts';
import type { AssistantMessage, TraceEntry } from '../src/state/types.ts';

const describeSpy = vi.fn();

vi.mock('../src/state/turnActivity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/state/turnActivity.ts')>();
  return {
    ...actual,
    // Wrapped rather than replaced: what is under test is *where* the sentence is derived, and a
    // fake sentence would make the announcement assertions vacuous.
    describeActivity: (activity: Parameters<typeof actual.describeActivity>[0]): string => {
      describeSpy(activity.kind);
      return actual.describeActivity(activity);
    },
  };
});

/** A streaming turn part-way through writing its answer. */
function streaming(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    role: 'assistant',
    at: 0,
    status: 'streaming',
    streamedText: '',
    finalText: '',
    trace: [],
    latestPlan: null,
    ...over,
  } as AssistantMessage;
}

/** One open tool call — the trace entry that makes `turnActivity` report `kind: 'tool'`. */
const openCall = (tool: string): TraceEntry =>
  ({
    id: `t-${tool}`,
    kind: 'tool_call',
    at: 0,
    toolCall: { tool, arguments: '{}' },
  }) as unknown as TraceEntry;

let heard: string[];
let unregister: (() => void) | null = null;

beforeEach(() => {
  cleanup();
  heard = [];
  describeSpy.mockClear();
  unregister = registerAnnouncer((message) => heard.push(message));
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

describe('the row on a streaming turn', () => {
  it('derives its sentence in render, so the effect depends on strings and not on a fresh object', () => {
    const { rerender } = render(<ActivityRow message={streaming({ streamedText: 'The' })} />);
    for (let i = 1; i <= 60; i += 1) {
      // What the store does every animation frame: a new message object, the same activity.
      rerender(<ActivityRow message={streaming({ streamedText: 'The '.repeat(i) })} />);
    }

    // Once per render. Before the change this ran inside the effect, so it ran once in 61 renders
    // — which is what let the effect itself be scheduled 61 times to do nothing.
    expect(describeSpy.mock.calls.length).toBeGreaterThan(30);
    // And the thing that must not have changed: one announcement, because the kind did not change.
    expect(heard).toEqual(['Writing the answer.']);
  });

  it('announces again when the kind changes, and only then', () => {
    const { rerender } = render(<ActivityRow message={streaming()} />);
    expect(heard).toEqual(['Thinking.']);

    rerender(<ActivityRow message={streaming({ trace: [openCall('screen_hazards')] })} />);
    expect(heard).toEqual(['Thinking.', 'Calling screen_hazards.']);

    // Same kind, different detail: the row's text changes, the announcement does not. A screen
    // reader being told about every tool in a five-source sweep is the failure this guards.
    rerender(<ActivityRow message={streaming({ trace: [openCall('lookup_solvent')] })} />);
    expect(heard).toEqual(['Thinking.', 'Calling screen_hazards.']);
  });

  it('says nothing at all for a turn that has settled', () => {
    render(<ActivityRow message={streaming({ status: 'done', finalText: 'Done.' })} />);
    expect(heard).toEqual([]);
  });
});
