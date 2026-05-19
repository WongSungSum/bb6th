import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { users, sections, rank, permissions } from './schema'
import * as dotenv from 'dotenv'
import bcrypt from 'bcryptjs'

dotenv.config({ path: '.env.local' })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

const db = drizzle(pool)

async function seed() {
  try {
    const pjnr =  "Pre-Junior";
    const jnr = "Junior";
    const snr = "Senior";
    const ofc = "Officer";
    const admin = "Admin";
    const sadmin= "Super Admin";
    console.log("Seeding Sections...");
    const insertSection =await db.insert(sections).values([
      { name: pjnr },
      { name: jnr },
      { name: snr },
      { name: ofc },
      { name: admin }
    ]).returning();
    console.log("✅Section Seeding Done!");
    
    console.log("Seeding Rank...");
    const sectionMap = Object.fromEntries(
      insertSection.map((s) => [s.name, s.id])
    );
    const prejunsec = sectionMap[pjnr];
    const junsec = sectionMap[jnr];
    const sensec = sectionMap[snr];
    const offsec = sectionMap[ofc];
    const adminsec = sectionMap[admin];
    const insertRank = await db.insert(rank).values([
      { 
        sectionId: prejunsec,
        desc: "member"        
      },
      { 
        sectionId: junsec,
        desc: "member"        
      },
      { 
        sectionId: sensec,
        desc: "member"        
      },
      { 
        sectionId: offsec,
        desc: "member"        
      },
      { 
        sectionId: adminsec,
        desc: sadmin
      },
    ]).returning();
    console.log("✅ Rank Seeding Done!");
    
    console.log("Seeding Permission...");
    await db.insert(permissions).values([
      { 
        slug: "users::view",
        description: "View Users"
      },{
        slug: "users::create",
        description: "Create User"
      },{
        slug: "users::edit",
        description: "Edit User",
      },{
        slug: "user::delete",
        description:"Delete User",
      }
    ]);
    console.log("✅ Permission Seeding Done!");
    console.log('Creating superadmin...');
    const superAdminRankId = insertRank.find((r) => r.desc === 'Super Admin')?.id;

    if (!superAdminRankId) {
      throw new Error("CRITICAL: Super Admin rank not found in database!");
    }




    const hashedPassword = await bcrypt.hash('admin', 10);

    await db.insert(users).values({
      email: 'admin@bb6thsibu.com',
      username: 'superadmin',
      password: hashedPassword,
      fullName: 'Super Admin',
      isActive: true,
      rankId: superAdminRankId
    }).onConflictDoNothing();

    console.log('✅ Superadmin created!');
  } catch (error) {
    console.error('Seed failed:', error);
    throw error; // Re-throw to be caught by the .catch below
  } finally {
    await pool.end(); // 👈 This closes the connection properly
  }
}

seed().then(() => {
  console.log('\n🎉 Seed complete!');
  process.exit(0);
}).catch((err) => {
  process.exit(1);
});