import { Database } from 'bun:sqlite';

import { inboundDbPath, TutorError } from './util';
import { openClass } from './store';

export interface Routing {
  channel_type: string;
  platform_id: string;
  thread_id: string;
}

export type ActorContext =
  | { role: 'tutor'; actorId: string; routing: Routing; messagingGroupId: string }
  | { role: 'student'; actorId: string; studentId: string; displayName: string; status: string; routing: Routing; messagingGroupId: string };

export function readRouting(dbPath = inboundDbPath()): Routing {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query('SELECT channel_type, platform_id, COALESCE(thread_id, \'\') AS thread_id FROM session_routing WHERE id = 1').get() as Routing | null;
    if (!row?.channel_type || !row.platform_id) throw new TutorError('routing context unavailable', 77);
    return row;
  } finally {
    db.close();
  }
}

export function resolveActor(root: string, routing = readRouting()): ActorContext {
  const db = openClass(root);
  try {
    const tutor = db.query(`SELECT id, messaging_group_id FROM tutor_bindings
      WHERE channel_type=$channel AND platform_id=$platform AND thread_id=$thread AND active=1`).get({
        $channel: routing.channel_type, $platform: routing.platform_id, $thread: routing.thread_id,
      }) as { id: string; messaging_group_id: string } | null;
    if (tutor) return { role: 'tutor', actorId: tutor.id, routing, messagingGroupId: tutor.messaging_group_id };

    const student = db.query(`SELECT s.id, s.display_name, s.status, b.messaging_group_id
      FROM student_channel_bindings b JOIN students s ON s.id=b.student_id
      WHERE b.channel_type=$channel AND b.platform_id=$platform AND b.thread_id=$thread`).get({
        $channel: routing.channel_type, $platform: routing.platform_id, $thread: routing.thread_id,
      }) as { id: string; display_name: string; status: string; messaging_group_id: string } | null;
    if (!student || student.status !== 'approved') throw new TutorError('current channel is not authorized for tutor access', 77);
    return {
      role: 'student', actorId: student.id, studentId: student.id, displayName: student.display_name,
      status: student.status, routing, messagingGroupId: student.messaging_group_id,
    };
  } finally {
    db.close();
  }
}

export function requireTutor(actor: ActorContext): asserts actor is Extract<ActorContext, { role: 'tutor' }> {
  if (actor.role !== 'tutor') throw new TutorError('tutor control channel required', 77);
}

export function requireStudent(actor: ActorContext): asserts actor is Extract<ActorContext, { role: 'student' }> {
  if (actor.role !== 'student') throw new TutorError('student channel required', 77);
}
