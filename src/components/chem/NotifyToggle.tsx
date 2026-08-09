/**
 * Opt in to a notification when a background job finishes.
 *
 * Lives in the sidebar footer — a settings-shaped place people go on purpose. Not the composer,
 * which is crowded and is not where you think about jobs; and not the job-feed band, which only
 * exists *after* a completion has already landed, far too late to arm the feature for that job.
 *
 * `requestPermission()` is called inside the click handler and nowhere else. Chrome requires a
 * user gesture, and an unprompted dialog at load is how an app earns a permanent `denied`.
 *
 * The stored preference is deliberately separate from `Notification.permission`: they are
 * different facts. Permission can be revoked in browser settings while the preference stays on,
 * and the control must then say "blocked by the browser" rather than silently doing nothing.
 */

import { useEffect, useState } from 'react';
import { useChatStore } from '../../state/chatStore.ts';
import { Label, Switch } from '@/components/ui/misc';

type Permission = 'unsupported' | NotificationPermission;

const read = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export function NotifyToggle(): React.JSX.Element | null {
  const enabled = useChatStore((s) => s.notifyOnJobComplete);
  const setEnabled = useChatStore((s) => s.setNotifyOnJobComplete);
  const [permission, setPermission] = useState<Permission>(read);

  // Permission can change in browser settings while the tab is open.
  useEffect(() => {
    const onFocus = (): void => setPermission(read());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Nothing to offer — iOS Safari outside an installed PWA, for one. Showing a dead switch would
  // be worse than showing none.
  if (permission === 'unsupported') return null;

  const blocked = permission === 'denied';

  const onChange = async (next: boolean): Promise<void> => {
    if (!next) {
      setEnabled(false);
      return;
    }
    if (permission === 'default') {
      const granted = await Notification.requestPermission();
      setPermission(granted);
      setEnabled(granted === 'granted');
      return;
    }
    setEnabled(permission === 'granted');
  };

  return (
    <div className="flex items-start gap-2">
      <Switch
        id="notify-jobs"
        checked={enabled && !blocked}
        disabled={blocked}
        onCheckedChange={(v) => void onChange(v)}
        aria-describedby="notify-jobs-hint"
      />
      <div className="min-w-0">
        <Label htmlFor="notify-jobs" className="text-2xs font-normal">
          Notify me when a job finishes
        </Label>
        <p id="notify-jobs-hint" className="mt-0.5 text-2xs leading-snug text-ink-subtle">
          {blocked
            ? 'Blocked by the browser — allow notifications for this site to turn it on.'
            : 'Only while this tab is in the background. A QM run can take hours.'}
        </p>
      </div>
    </div>
  );
}
