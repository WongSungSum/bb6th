import {
  pgTable, uuid, text, integer, boolean, timestamp, date, jsonb, 
  primaryKey, smallint, varchar, smallserial
} from 'drizzle-orm/pg-core';

export const sections = pgTable('sections', {
  id: smallserial('id').primaryKey(),
  name: text('name').notNull(),
});

export const rank = pgTable('rank', {
  id: smallserial('id').primaryKey(),
  sectionId: smallint("section_id").notNull().references(() => sections.id, { onDelete: "cascade" }), 
  greet: varchar('greet', { length: 10 }),
  desc: text('desc').notNull(),
});

export const roles = pgTable("roles", {
  id: smallserial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  sectionId: smallint("section_id").references(() => sections.id, { onDelete: "set null" }), 
  description: text('description').notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  email: text('email').unique().notNull(),
  username: text('username').unique().notNull(),
  password: text('password').notNull(),
  
  rankId: smallint('rank_id')
    .notNull()
    .references(() => rank.id, { onDelete: "restrict" }), 
    
  roleId: smallint('role_id')
    .references(() => roles.id, { onDelete: "set null" }),

  fullName: text('full_name').notNull(),
  gender: text('gender'),
  phone: text('phone'),
  address: text('address'),
  school: text('school'),
  avatarUrl: text('avatar_url'),
  
  isActive: boolean('is_active').default(true).notNull(),
  
  token: text('token'), 
  
});

export const permissions = pgTable("permissions", {
  slug: text("slug").primaryKey(),
  description: text("description"), 
});

export const rolePermissions = pgTable("role_permissions", {
  roleId: smallint("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionId: text("permission_id").notNull().references(() => permissions.slug, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ name: "role_permissions_pk", columns: [t.roleId, t.permissionId] }),
]);

export const userPermissions = pgTable("user_permissions", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permissionId: text("permission_id").notNull().references(() => permissions.slug, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ name: "user_permissions_pk", columns: [t.userId, t.permissionId] }),
]);

// 奖章主表
export const awards = pgTable('awards', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
});
export const awardRequirement = pgTable('award_require', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  awardId: uuid('award_id')
    .notNull() 
    .references(() => awards.id, { onDelete: 'cascade' }),
    
  reqText: text('req_text'),
  
  reqAwardId: uuid('req_award_id')
    .references(() => awards.id),
    
  notes: text('notes'),
});
export const userAwards = pgTable('user_awards', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  awardId: uuid('award_id').notNull().references(() => awards.id),
  
  certifiedAt: timestamp('certified_at'),
  certifiedBy: uuid('certified_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  approvedBy: uuid('approved_by').references(() => users.id),
  awardedAt: timestamp('awarded_at'),
  awardedBy: uuid('awarded_by').references(() => users.id),

  notes: text('notes'), 
});

// 考勤表
export const attendance = pgTable('attendance', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  date: date('date').notNull(), // 具体的签到日期
  status: text('status').default('present'), 
  markedBy: uuid('marked_by').references(() => users.id),
});

// 系统日志
export const logs = pgTable('logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tableName: text('table_name').notNull(),
  recordId: text('record_id').notNull(),
  action: text('action').notNull(), // CREATE, UPDATE, DELETE
  data: jsonb('data'),
  userId: uuid('user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});