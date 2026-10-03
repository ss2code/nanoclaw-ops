import type { Database } from 'bun:sqlite';
export function dayOf(db: Database, date: string, memberId?: number): any[] {
  const legs = db.query(`SELECT l.*,m.display_name,p1.name AS from_name,p2.name AS to_name FROM legs l JOIN members m ON m.id=l.member_id LEFT JOIN places p1 ON p1.id=l.from_place_id LEFT JOIN places p2 ON p2.id=l.to_place_id WHERE l.status='committed' AND substr(l.depart,1,10)=$date${memberId != null ? ' AND l.member_id=$member' : ''} ORDER BY l.member_id,l.depart,l.id`).all(memberId != null ? { $date: date, $member: memberId } : { $date: date }) as any[];
  const members = new Map<number, any>();
  for (const leg of legs) members.set(leg.member_id, { memberId: leg.member_id, name: leg.display_name, legs: [], stay: null });
  for (const leg of legs) members.get(leg.member_id).legs.push(leg);
  const stay = db.query(`SELECT s.*,p.name AS place_name,p.address,pi.value AS host_phone FROM stays s LEFT JOIN places p ON p.id=s.place_id LEFT JOIN place_info pi ON pi.place_id=s.place_id AND pi.key='host_phone' WHERE s.status='committed' AND s.check_in <= $date AND s.check_out > $date ORDER BY s.check_in LIMIT 1`).get({ $date: date }) as any;
  for (const m of members.values()) m.stay = stay ?? null;
  return [...members.values()];
}
