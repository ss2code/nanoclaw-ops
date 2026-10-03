import fs from 'node:fs';

import { audienceInstruction, resolveAudience } from '../app/audience';
import { ensureStudent, initializeRoot, openClass } from '../app/store';
import { now, parseArgs, requiredFlag, stableId, TutorError } from '../app/util';

export interface TutorInitialization {
  agentGroupId: string;
  className: string;
  subject: string;
  gradeLevel?: string | number;
  ageRange?: { min: number; max: number };
  tutor: {
    userId: string;
    messagingGroupId: string;
    channelType: string;
    platformId: string;
    threadId?: string;
  };
  students: Array<{
    id?: string;
    userId: string;
    displayName: string;
    messagingGroupId: string;
    channelType: string;
    platformId: string;
    threadId?: string;
    status?: 'pending' | 'approved' | 'paused' | 'archived';
  }>;
}

export function initialize(root: string, config: TutorInitialization): void {
  initializeRoot(root);
  const audience = resolveAudience(config);
  const db = openClass(root);
  db.query(`INSERT INTO class_config
    (id,agent_group_id,class_name,subject,created_at,grade_level,age_min,age_max,target_age,explanation_level)
    VALUES (1,$group,$class,$subject,$at,$grade,$ageMin,$ageMax,$targetAge,$explanation)
    ON CONFLICT(id) DO UPDATE SET agent_group_id=excluded.agent_group_id,class_name=excluded.class_name,
    subject=excluded.subject,grade_level=excluded.grade_level,age_min=excluded.age_min,age_max=excluded.age_max,
    target_age=excluded.target_age,explanation_level=excluded.explanation_level`).run({
      $group: config.agentGroupId, $class: config.className, $subject: config.subject, $at: now(),
      $grade: audience.grade_level, $ageMin: audience.age_min, $ageMax: audience.age_max,
      $targetAge: audience.target_age, $explanation: audience.explanation_level,
    });
  db.query(`INSERT INTO tutor_bindings (id,user_id,messaging_group_id,channel_type,platform_id,thread_id,active,created_at)
    VALUES ('tutor_control',$user,$mg,$channel,$platform,$thread,1,$at)
    ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,messaging_group_id=excluded.messaging_group_id,
    channel_type=excluded.channel_type,platform_id=excluded.platform_id,thread_id=excluded.thread_id,active=1`).run({
      $user: config.tutor.userId, $mg: config.tutor.messagingGroupId, $channel: config.tutor.channelType,
      $platform: config.tutor.platformId, $thread: config.tutor.threadId ?? '', $at: now(),
    });
  for (const student of config.students) {
    const id = student.id ?? stableId('stu', config.agentGroupId, student.userId);
    const status = student.status ?? 'approved';
    db.query(`INSERT INTO students (id,user_id,display_name,status,instructor_approved_at,created_at)
      VALUES ($id,$user,$name,$status,$approved,$at)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,display_name=excluded.display_name,
      status=excluded.status,instructor_approved_at=excluded.instructor_approved_at`).run({
        $id: id, $user: student.userId, $name: student.displayName, $status: status,
        $approved: status === 'approved' ? now() : null, $at: now(),
      });
    db.query(`INSERT INTO student_channel_bindings
      (student_id,messaging_group_id,channel_type,platform_id,thread_id,created_at)
      VALUES ($student,$mg,$channel,$platform,$thread,$at)
      ON CONFLICT(channel_type,platform_id,thread_id) DO UPDATE SET student_id=excluded.student_id,messaging_group_id=excluded.messaging_group_id`).run({
        $student: id, $mg: student.messagingGroupId, $channel: student.channelType,
        $platform: student.platformId, $thread: student.threadId ?? '', $at: now(),
      });
    ensureStudent(root, id, student.displayName);
  }
  db.query(`INSERT INTO policies (key,value_json,updated_at) VALUES ('mastery_bands','["low","medium","high"]',$at)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run({ $at: now() });
  db.query(`INSERT INTO policies (key,value_json,updated_at) VALUES ('audience.profile',$value,$at)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run({
      $value: JSON.stringify({ ...audience, instruction: audienceInstruction(audience) }), $at: now(),
    });
  db.close();
}

if (import.meta.main) {
  try {
    const { flags } = parseArgs(process.argv.slice(2));
    const root = requiredFlag(flags, 'root');
    const configPath = requiredFlag(flags, 'config');
    initialize(root, JSON.parse(fs.readFileSync(configPath, 'utf8')) as TutorInitialization);
    console.log('TUTOR APPLICATION INITIALIZED');
  } catch (error) {
    const code = error instanceof TutorError ? error.exitCode : 1;
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(code);
  }
}
