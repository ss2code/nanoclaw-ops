import { createHash, randomUUID } from 'node:crypto';

import {
  parseTutorConfig,
  type KnowledgeGraphTutorConfig,
} from '../host/admin.js';
import { resolveAudience } from '../app/audience.js';

export interface TutorPersonDraft {
  name: string;
  phone: string;
  telegramUserId: string;
  telegramGroupId: string;
  telegramGroupName: string;
}

export interface StudentDraft extends TutorPersonDraft {
  key: string;
  rollNumber: string;
}

export interface TutorConsoleDraft {
  schema: 1;
  id: string;
  folder: string;
  displayName: string;
  classNumber: string;
  section: string;
  subject: string;
  model: string;
  tutor: TutorPersonDraft;
  students: StudentDraft[];
  updatedAt: string;
}

export interface DraftValidation {
  errors: string[];
  warnings: string[];
}

const SAFE_ID = /^[a-z][a-z0-9-]{0,49}$/;
const SAFE_FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TELEGRAM_GROUP = /^telegram:-\d+$/;
const TELEGRAM_USER = /^telegram:\d+$/;

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
}

export function defaultDraft(): TutorConsoleDraft {
  return {
    schema: 1,
    id: '',
    folder: '',
    displayName: '',
    classNumber: '',
    section: '',
    subject: '',
    model: '',
    tutor: {
      name: '',
      phone: '',
      telegramUserId: '',
      telegramGroupId: '',
      telegramGroupName: '',
    },
    students: [newStudentDraft()],
    updatedAt: new Date(0).toISOString(),
  };
}

export function newStudentDraft(): StudentDraft {
  return {
    key: randomUUID(),
    name: '',
    phone: '',
    rollNumber: '',
    telegramUserId: '',
    telegramGroupId: '',
    telegramGroupName: '',
  };
}

function telegramId(value: string, kind: 'user' | 'group'): string {
  const raw = value.trim().replace(/^telegram:/i, '');
  if (!raw) return '';
  const normalized = kind === 'group' && !raw.startsWith('-') ? `-${raw}` : raw;
  return `telegram:${normalized}`;
}

export function deriveIdentity(draft: TutorConsoleDraft): TutorConsoleDraft {
  const classLabel = [draft.classNumber.trim(), draft.section.trim()].filter(Boolean).join(' – ');
  const base = slugify(`${classLabel}-${draft.subject}`) || 'new-class';
  return {
    ...draft,
    id: draft.id.trim() || `ag-${base}`.slice(0, 50),
    folder: draft.folder.trim() || base.slice(0, 64),
    displayName: draft.displayName.trim() || `${classLabel} ${draft.subject} Tutor`.trim(),
  };
}

export function validateDraft(input: TutorConsoleDraft): DraftValidation {
  const draft = deriveIdentity(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!draft.classNumber.trim()) errors.push('Class number or class label is required.');
  if (!draft.subject.trim()) errors.push('Subject is required.');
  if (!SAFE_ID.test(draft.id)) errors.push('Application ID must start with a letter and contain only lowercase letters, numbers, and hyphens.');
  if (!SAFE_FOLDER.test(draft.folder)) errors.push('Folder must contain only lowercase letters, numbers, dots, underscores, and hyphens.');
  if (!draft.tutor.name.trim()) errors.push('Tutor name is required.');
  if (!TELEGRAM_USER.test(telegramId(draft.tutor.telegramUserId, 'user'))) errors.push('Pair the tutor Telegram group before creating the class.');
  if (!TELEGRAM_GROUP.test(telegramId(draft.tutor.telegramGroupId, 'group'))) errors.push('Tutor Telegram group ID is missing or invalid.');
  if (draft.students.length === 0) errors.push('Add at least one student.');
  for (const [index, student] of draft.students.entries()) {
    const label = `Student ${index + 1}`;
    if (!student.name.trim()) errors.push(`${label} name is required.`);
    if (!TELEGRAM_USER.test(telegramId(student.telegramUserId, 'user'))) errors.push(`${label} Telegram identity has not been paired.`);
    if (!TELEGRAM_GROUP.test(telegramId(student.telegramGroupId, 'group'))) errors.push(`${label} Telegram group has not been paired.`);
  }
  const users = [
    telegramId(draft.tutor.telegramUserId, 'user'),
    ...draft.students.map((student) => telegramId(student.telegramUserId, 'user')),
  ].filter(Boolean);
  if (new Set(users).size !== users.length) errors.push('Tutor and students must use different Telegram accounts.');
  const groups = [
    telegramId(draft.tutor.telegramGroupId, 'group'),
    ...draft.students.map((student) => telegramId(student.telegramGroupId, 'group')),
  ].filter(Boolean);
  if (new Set(groups).size !== groups.length) errors.push('Every tutor or student role must use a different Telegram group.');
  if (draft.students.length < 2) warnings.push('One student is enough for a smoke test; add a second fake student for a meaningful privacy test.');
  return { errors, warnings };
}

export function buildTutorConfig(input: TutorConsoleDraft): KnowledgeGraphTutorConfig {
  const draft = deriveIdentity(input);
  const validation = validateDraft(draft);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const className = [draft.classNumber.trim(), draft.section.trim()].filter(Boolean).join(' – ');
  const gradeMatch = draft.classNumber.match(/\d{1,2}/);
  const audience = resolveAudience({ className, gradeLevel: gradeMatch ? Number(gradeMatch[0]) : undefined });
  const config: KnowledgeGraphTutorConfig = {
    id: draft.id,
    name: draft.displayName,
    folder: draft.folder,
    className,
    subject: draft.subject.trim(),
    gradeLevel: audience.grade_level,
    ageRange: { min: audience.age_min, max: audience.age_max },
    model: draft.model.trim() || undefined,
    tutor: {
      user: telegramId(draft.tutor.telegramUserId, 'user'),
      displayName: draft.tutor.name.trim(),
      channel: {
        channel: 'telegram',
        platformId: telegramId(draft.tutor.telegramGroupId, 'group'),
        name: draft.tutor.telegramGroupName.trim() || `${className} ${draft.subject} — Tutor Control`,
      },
    },
    students: draft.students.map((student) => ({
      user: telegramId(student.telegramUserId, 'user'),
      displayName: student.name.trim(),
      channel: {
        channel: 'telegram',
        platformId: telegramId(student.telegramGroupId, 'group'),
        name: student.telegramGroupName.trim() || `${className} ${draft.subject} — ${student.name.trim()}`,
      },
    })),
    coursework: [],
  };
  const parsed = parseTutorConfig(config);
  if (!parsed.config) throw new Error(parsed.errors.join('\n'));
  return parsed.config;
}

export function publicDraft(draft: TutorConsoleDraft): TutorConsoleDraft {
  return structuredClone(draft);
}

export function stableActionToken(seed = randomUUID()): string {
  return createHash('sha256').update(seed).digest('base64url');
}
