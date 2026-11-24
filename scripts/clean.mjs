// Empties dist before a build, so a removed source file leaves nothing behind.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
