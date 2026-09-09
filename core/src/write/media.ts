/**
 * Media library writes.
 *
 * Deletion refuses while anything still references a file, and says what: a
 * silently broken product image is discovered by a customer, not by us. The
 * database row goes before the stored object, deliberately — a crash between
 * the two leaves an orphan the nightly GC reclaims, which is strictly better
 * than the reverse, where a live row would point at nothing.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  mediaUpdateSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { deleteObjects } from '../r2.ts';

export async function updateMediaAltText(
  actor: Actor,
  id: string,
  input: unknown,
): Promise<ActionResult> {
  assertPermission(actor, 'media:write');

  const parsed = mediaUpdateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.media.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return actionError('That file no longer exists.');

  await prisma.media.update({
    where: { id },
    data: {
      altTextEn: parsed.data.altTextEn ?? null,
      altTextHi: parsed.data.altTextHi ?? null,
    },
  });

  await recordAudit(actor, {
    action: 'media.update',
    entityType: 'Media',
    entityId: id,
  });

  return actionOk();
}

/**
 * Deletes a file from the library and from R2.
 *
 * Refuses while anything still references it, and says what — a silently broken
 * product image is discovered by a customer, not by us. The database row goes
 * first and the object second: a crash between the two leaves an orphaned object
 * that the nightly GC reclaims, which is strictly better than the reverse, where
 * a live row would point at nothing.
 */
export async function deleteMedia(actor: Actor, id: string): Promise<ActionResult> {
  assertPermission(actor, 'media:delete');

  const media = await prisma.media.findUnique({
    where: { id },
    select: {
      id: true,
      r2Key: true,
      filename: true,
      _count: {
        select: {
          productImages: true,
          categories: true,
          brands: true,
          bannersDesktop: true,
          bannersMobile: true,
        },
      },
    },
  });

  if (!media) return actionError('That file no longer exists.');

  const references: string[] = [];
  const c = media._count;
  if (c.productImages > 0) references.push(`${c.productImages} product${c.productImages === 1 ? '' : 's'}`);
  if (c.categories > 0) references.push(`${c.categories} categor${c.categories === 1 ? 'y' : 'ies'}`);
  if (c.brands > 0) references.push(`${c.brands} brand${c.brands === 1 ? '' : 's'}`);
  const bannerCount = c.bannersDesktop + c.bannersMobile;
  if (bannerCount > 0) references.push(`${bannerCount} banner${bannerCount === 1 ? '' : 's'}`);

  if (references.length > 0) {
    return actionError(
      `“${media.filename}” is still used by ${references.join(', ')}. Remove it there first.`,
    );
  }

  await prisma.media.delete({ where: { id } });

  try {
    await deleteObjects([media.r2Key]);
  } catch (error) {
    // The row is already gone, so the file is out of the library either way.
    // The stored object becomes an orphan the GC will collect.
    console.error('[media] deleted row but could not remove R2 object', media.r2Key, error);
  }

  await recordAudit(actor, {
    action: 'media.delete',
    entityType: 'Media',
    entityId: id,
    diff: { filename: media.filename, r2Key: media.r2Key },
  });

  return actionOk();
}

/**
 * Deletes many files, skipping any that are still referenced.
 *
 * Partial success rather than all-or-nothing: selecting thirty files and having
 * the whole operation refused because one is attached to a product would be
 * infuriating. The blocked names come back so the UI can say which survived
 * instead of quietly returning a smaller number than expected.
 */
export async function deleteManyMedia(
  actor: Actor,
  ids: string[],
): Promise<ActionResult<{ deleted: number; blocked: string[] }>> {
  assertPermission(actor, 'media:delete');

  if (!Array.isArray(ids) || ids.length === 0) return actionError('Nothing selected.');
  if (ids.length > 200) return actionError('Select 200 files or fewer at a time.');

  const rows = await prisma.media.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      r2Key: true,
      filename: true,
      _count: {
        select: {
          productImages: true,
          categories: true,
          brands: true,
          bannersDesktop: true,
          bannersMobile: true,
        },
      },
    },
  });

  const deletable: Array<{ id: string; r2Key: string }> = [];
  const blocked: string[] = [];

  for (const row of rows) {
    const c = row._count;
    const used =
      c.productImages + c.categories + c.brands + c.bannersDesktop + c.bannersMobile > 0;
    if (used) blocked.push(row.filename);
    else deletable.push({ id: row.id, r2Key: row.r2Key });
  }

  if (deletable.length > 0) {
    await prisma.media.deleteMany({ where: { id: { in: deletable.map((d) => d.id) } } });
    try {
      await deleteObjects(deletable.map((d) => d.r2Key));
    } catch (error) {
      console.error('[media] bulk rows deleted but R2 cleanup failed', error);
    }

    await recordAudit(actor, {
      action: 'media.bulkDelete',
      entityType: 'Media',
      entityId: `${deletable.length} files`,
      diff: { deleted: deletable.map((d) => d.r2Key), blocked },
    });
  }

  return actionOk({ deleted: deletable.length, blocked });
}
