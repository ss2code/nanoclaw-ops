import { TutorError } from './util.js';

export interface AudienceProfile {
  grade_level: string;
  age_min: number;
  age_max: number;
  target_age: number;
  explanation_level: string;
}

function inferredGrade(className: string): number | null {
  const match = className.match(/(?:class|grade|year)\s*[-:]?\s*(\d{1,2})/i);
  return match ? Number(match[1]) : null;
}

export function resolveAudience(input: {
  className: string;
  gradeLevel?: string | number;
  ageRange?: { min: number; max: number };
}): AudienceProfile {
  const inferred = inferredGrade(input.className);
  const grade = input.gradeLevel === undefined ? inferred : Number(input.gradeLevel);
  if (!Number.isInteger(grade) || Number(grade) < 1 || Number(grade) > 16) {
    throw new TutorError('gradeLevel is required (or must be inferable from className) and must be between 1 and 16', 64);
  }
  const ageMin = input.ageRange?.min ?? Number(grade) + 6;
  const ageMax = input.ageRange?.max ?? Number(grade) + 7;
  if (!Number.isInteger(ageMin) || !Number.isInteger(ageMax) || ageMin < 5 || ageMax > 22 || ageMin > ageMax) {
    throw new TutorError('ageRange must contain whole-number min/max ages between 5 and 22', 64);
  }
  const targetAge = Math.round((ageMin + ageMax) / 2);
  return {
    grade_level: String(grade), age_min: ageMin, age_max: ageMax, target_age: targetAge,
    explanation_level: `ELI ${targetAge}`,
  };
}

export function audienceInstruction(profile: AudienceProfile): string {
  return `${profile.explanation_level}: write for Grade ${profile.grade_level}, normally ages ${profile.age_min}-${profile.age_max}. ` +
    'Use accurate subject vocabulary, define unfamiliar terms in plain language, keep reasoning explicit, and avoid both childish simplification and expert-level compression.';
}
