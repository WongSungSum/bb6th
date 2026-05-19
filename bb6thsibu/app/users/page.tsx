import Users from './users';

import { auth } from "@/auth";
import { users } from "@/lib/schema";
import { checkPermission } from '@/lib/permission';
import { db } from "@/lib/db";

const session = await auth();
const allUsers = await db.query.users.findMany({
        orderBy: (users, { asc }) => [asc(users.fullName)],
    });
export default function UsersPage(){
    console.log(session);
    return (
        <Users initialData={allUsers}></Users>
    )
}