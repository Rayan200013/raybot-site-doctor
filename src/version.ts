// The version and the name the server gives every site it reads.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const NAME = 'raybot-site-doctor';
export const VERSION = pkg.version;
export const REPOSITORY = 'https://github.com/Rayan200013/raybot-site-doctor';
/** The token robots.txt rules are matched against. */
export const ROBOTS_TOKEN = NAME;
export const USER_AGENT = `${NAME}/${VERSION} (+${REPOSITORY})`;
