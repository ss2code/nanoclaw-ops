// Trip identity + roster config now lives in trip-core (design §6 extraction).
// trip-finance re-exports it so every existing importer (`./config`) keeps
// resolving unchanged. Finance reads this config (never writes it, except via
// the same CLI that always called these functions).

export { setTrip, addFamily, addMember, updateMember } from '../../trip-core/scripts/config';
