import { ulid } from 'ulid';

/** New ULID — the id format for every entity. */
export const newId = (): string => ulid();
