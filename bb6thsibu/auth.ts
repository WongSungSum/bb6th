import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import { users, sections, rank } from '@/lib/schema'
import { eq, or } from 'drizzle-orm'
import bcrypt from 'bcryptjs'

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        login: { label: 'Email or Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
        platform: { type: 'text' } // Hidden field passed from sign-in
      },
      async authorize(credentials) {
        if (!credentials?.login || !credentials?.password) {
          return null
        }

        const login = credentials.login as string
        const password = credentials.password as string

        const result = await db
          .select({
            user: users,        
            rank: rank,
            section: sections
          })
          .from(users)
          .leftJoin(rank, eq(users.rankId, rank.id)) 
          .leftJoin(sections, eq(rank.sectionId, sections.id))
          .where(
            or(
              eq(users.email, login),
              eq(users.username, login)
            )
          )
          .limit(1)

        const data = result[0]
        if (!data) return null
        const { user, rank: userRank, section: userSection } = data
        const passwordMatch = await bcrypt.compare(
          password,
          user.password
        )

        if (!passwordMatch) return null
        if (!user.isActive) return null

        return {
          id: user.id.toString(),
          email: user.email ?? '',
          name: user.fullName ?? user.username,
          rank: userRank?.desc ?? "member",
          roleId: user.roleId,
          rankId: user.rankId,
          greet: userRank?.greet ?? "", // 添加这一行
          section: userSection?.name ?? "",
          username: user.username,
          platform: credentials.platform 
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const now = Math.floor(Date.now() / 1000);

      if (user) {
        // 当用户第一次登录时，将所有自定义字段存入 JWT
        token.id = user.id;
        token.username = (user as any).username;
        token.platform = (user as any).platform;
        token.section = (user as any).section;
        token.roleId = (user as any).roleId;
        token.rankId = (user as any).rankId;
        token.rank = (user as any).rank;
        token.greet = (user as any).greet;
        token.createdAt = now;
      }

      // 你的 Web 端 30 分钟过期逻辑保持不变
      if (token.platform !== 'apk') {
        const age = now - (token.createdAt as number);
        if (age > 30 * 60) return null;
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        // 将字段从 Token 映射到 Session 对象上
        (session.user as any).id = token.id;
        (session.user as any).username = token.username;
        (session.user as any).roleId = token.roleId;
        (session.user as any).rankId = token.rankId;
        (session.user as any).rank = token.rank;
        (session.user as any).greet = token.greet;
      }
      return session;
    },
  },
  session: {
    strategy: 'jwt',
    maxAge: 90 * 24 * 60 * 60, // Set global limit to 90 days
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
})