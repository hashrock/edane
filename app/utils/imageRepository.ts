/**
 * Image rows (D1). The quota is checked inside the INSERT itself: a separate
 * "sum, then insert" let parallel uploads each pass the check and together
 * exceed it.
 */
export interface NewImage {
  id: string;
  userId: string;
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/** Insert the row only if the user's total stays within `limitBytes`. False = over the quota, nothing written. */
export async function insertImageWithinQuota(db: D1Database, image: NewImage, limitBytes: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO images (id, user_id, r2_key, filename, content_type, size, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COALESCE(SUM(size), 0) FROM images WHERE user_id = ?) + ? <= ?`
    )
    .bind(
      image.id,
      image.userId,
      image.r2Key,
      image.filename,
      image.contentType,
      image.size,
      image.createdAt,
      image.userId,
      image.size,
      limitBytes
    )
    .run();
  return result.meta.changes === 1;
}
