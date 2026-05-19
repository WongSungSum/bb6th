import { db } from './db';
import { Log } from './schema';
import { eq } from 'drizzle-orm';

/**
 * 脱敏工具：确保敏感信息不会进入日志表
 */
const sanitize = (obj: any) => {
  if (!obj) return null;
  // 根据你的 schema，脱敏 password 和 token
  const { password, token, ...safeData } = obj;
  return safeData;
};

export const auditDb = {
  /**
   * CREATE: 插入新数据并记录
   */
  create: async (table: any, values: any, actorId: string) => {
    return await db.transaction(async (tx) => {
      const rows = (await tx.insert(table).values(values).returning()) as any[];
      const newData = rows[0];

      if (!newData) throw new Error("Insert failed");

      await tx.insert(Log).values({
        tableName: table[Symbol.for('drizzle:Name')],
        recordId: newData.id.toString(), // 统一转为 string 存储
        action: 'INSERT',
        data: sanitize(newData), // 既然你没开 newData 字段，INSERT 时可以把初始数据存入 oldData
        updateBy: actorId,
        createdAt: new Date(),
      });

      return newData;
    });
  },

  /**
   * UPDATE: 更新数据
   */
  update: async (table: any, id: string, updates: any, actorId: string) => {
    return await db.transaction(async (tx) => {
      const rows = (await tx
        .update(table)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(table.id, id))
        .returning()) as any[];
      
      const newData = rows[0];
      if (!newData) throw new Error("Update failed: Record not found");

      await tx.insert(Log).values({
        tableName: table[Symbol.for('drizzle:Name')],
        recordId: id.toString(),
        action: 'UPDATE',
        data: sanitize(newData), // 将更新后的快照存入
        updateBy: actorId,
        createdAt: new Date(),
      });

      return newData;
    });
  },

  /**
   * DELETE: 删除数据并备份
   */
  delete: async (table: any, id: string, actorId: string) => {
    return await db.transaction(async (tx) => {
      const rows = (await tx
        .select()
        .from(table)
        .where(eq(table.id, id))
        .limit(1)) as any[];
      
      const oldData = rows[0];
      if (!oldData) throw new Error("Delete failed: Record not found");

      // 2. 物理删除
      await tx.delete(table).where(eq(table.id, id));

      // 3. 记录日志备份
      await tx.insert(Log).values({
        tableName: table[Symbol.for('drizzle:Name')],
        recordId: id.toString(),
        action: 'DELETE',
        data: sanitize(oldData), // 备份数据到 old_data
        updateBy: actorId,
        createdAt: new Date(),
      });

      return { success: true };
    });
  }
};