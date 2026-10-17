/**
 * An op is noun:verb. The noun has no hyphen, so the folder `job-create-batch` reads back as
 * `job:create-batch` and nothing else.
 */
export const OP_NAME = /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/;
export const opFolder = (name: string): string => name.replace(":", "-");
export const opFromFolder = (folder: string): string => folder.replace("-", ":");
