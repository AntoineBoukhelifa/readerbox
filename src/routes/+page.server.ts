import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth/sessions';
import { retirerCookieDeSession } from '$lib/server/auth/cookies';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { member: locals.member };
};

export const actions: Actions = {
	deconnexion: async ({ cookies, platform }) => {
		const token = cookies.get(SESSION_COOKIE);
		const d1 = platform?.env?.DB;
		if (token && d1) await revokeSession(getDb(d1), token);
		retirerCookieDeSession(cookies);
		redirect(303, '/');
	}
};
