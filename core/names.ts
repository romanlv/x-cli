/**
 * An op is noun:verb. The noun has no hyphen, so the folder `job-create-batch` reads back as
 * `job:create-batch` and nothing else.
 */
export const OP_NAME = /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/;
export const opFolder = (name: string): string => name.replace(":", "-");
export const opFromFolder = (folder: string): string => folder.replace("-", ":");

/** The CLI's own commands use these nouns, so no op can. */
export const CLI_NOUNS = ["context", "request", "page", "op"];
export const isCliNoun = (name: string): boolean => CLI_NOUNS.includes(name.split(":")[0]!);

/** An input's flag: `tenantStage` is `--tenant-stage`. */
export const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
