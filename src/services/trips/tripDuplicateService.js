/**
 * tripDuplicateService.js
 * Deep-copy a trip (with remapped dayPlanId -> newDayPlanId and new tripId) as a reusable blueprint.
 * Copies trip metadata, dayPlans, placeItems, and packingItems (reset isPacked=false).
 * Intentionally excludes personal expenses, settlement logs, and booking confirmation codes.
 */
import { tripRepo, dayPlanRepo, placeItemRepo, packingRepo } from '../db';
import { createStableId } from '../../utils/id';

export async function duplicateTrip(sourceTripId) {
    if (!sourceTripId) throw new Error('請指定要複製的旅程 ID');
    const sourceTrip = await tripRepo.get(sourceTripId);
    if (!sourceTrip) throw new Error('找不到來源旅程');

    const now = Date.now();
    const newTripId = createStableId('trip_');
    const newTrip = {
        ...sourceTrip,
        id: newTripId,
        title: `${sourceTrip.title} (副本)`,
        status: 'planning',
        isShared: false,
        createdAt: now,
        updatedAt: now,
    };

    const [sourceDays, sourcePlaces, sourcePacking] = await Promise.all([
        dayPlanRepo.getByTrip(sourceTripId).catch(() => []),
        placeItemRepo.getByTrip(sourceTripId).catch(() => []),
        packingRepo.getByTrip(sourceTripId).catch(() => []),
    ]);

    // 建立 oldDayPlanId -> newDayPlanId 映射表，確保所有景點正確綁定至新旅程
    const dayPlanIdMap = new Map();
    const newDays = sourceDays.map((dp) => {
        const nextId = createStableId('day_');
        dayPlanIdMap.set(dp.id, nextId);
        return {
            ...dp,
            id: nextId,
            tripId: newTripId,
            updatedAt: now,
        };
    });

    const newPlaces = sourcePlaces.map((pl) => ({
        ...pl,
        id: createStableId('place_'),
        tripId: newTripId,
        dayPlanId: pl.dayPlanId ? (dayPlanIdMap.get(pl.dayPlanId) || null) : null,
        updatedAt: now,
    }));

    const newPacking = sourcePacking.map((pk) => ({
        ...pk,
        id: createStableId('pack_'),
        tripId: newTripId,
        isPacked: false,
        createdAt: now,
        updatedAt: now,
    }));

    await tripRepo.save(newTrip);
    if (newDays.length > 0) await dayPlanRepo.saveBatch(newDays);
    if (newPlaces.length > 0) await placeItemRepo.saveBatch(newPlaces);
    if (newPacking.length > 0) await packingRepo.saveBatch(newPacking);

    return {
        trip: newTrip,
        copiedDays: newDays.length,
        copiedPlaces: newPlaces.length,
        copiedPacking: newPacking.length,
    };
}
