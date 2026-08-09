/**
 * Theme picker: light / dark / follow the system.
 *
 * Three states rather than a two-way switch, because "follow the system" is a real preference and
 * collapsing it into a boolean means a user who flips their OS at sunset has to flip this too.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, type ThemeChoice } from '@/state/themeStore';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const LABEL: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeToggle(): React.JSX.Element {
  const choice = useThemeStore((s) => s.choice);
  const resolved = useThemeStore((s) => s.resolved);
  const setChoice = useThemeStore((s) => s.setChoice);

  const Icon = choice === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${LABEL[choice]}`}>
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme — {LABEL[choice].toLowerCase()}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => setChoice(value as ThemeChoice)}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="size-3.5" /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-3.5" /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-3.5" /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
