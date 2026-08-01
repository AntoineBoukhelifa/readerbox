import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth/sessions';
import { retirerCookieDeSession } from '$lib/server/auth/cookies';
import { lireJournal } from '$lib/server/journal/entries';
import { listerOrdres } from '$lib/server/orders/orders';
import { pourcentageAffiche } from '$lib/server/orders/progression';
import type { Actions, PageServerLoad } from './$types';

/** Ce que l'accueil montre d'un coup, sans faire défiler. */
const AFFICHES_EN_ACCUEIL = 12;
const ORDRES_EN_ACCUEIL = 4;

/**
 * L'accueil — deux pages en une, selon qu'on est du groupe ou non.
 *
 * Déconnecté, il n'a rien à montrer : le groupe est fermé et il le dit.
 *
 * Connecté, il ouvre sur **ce qui est en cours**, pas sur des liens. Le geste
 * le plus fréquent du produit est de consigner un numéro qu'on vient de lire
 * (F1) : la première chose à l'écran doit donc être ce qu'on est en train de
 * lire, en affiches, cliquable. Les liens, eux, sont désormais dans la barre —
 * un accueil qui ne serait qu'un sommaire ferait doublon avec elle.
 */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!locals.member || !d1) {
		return { member: null, enCours: [], derniereLecture: [], ordres: [] };
	}

	const db = getDb(d1);
	const [journal, ordres] = await Promise.all([
		lireJournal(db, locals.member.id),
		listerOrdres(db, locals.member.id)
	]);

	const affiche = (entree: (typeof journal)[number]) => ({
		id: entree.oeuvre.id,
		titre: entree.oeuvre.titre,
		couvertureUrl: entree.oeuvre.couvertureUrl,
		position: entree.position,
		note: entree.note
	});

	return {
		member: locals.member,
		// Le journal arrive déjà trié du plus récemment touché au plus ancien.
		enCours: journal
			.filter((entree) => !entree.abandonnee && entree.etagere === 'en_cours')
			.slice(0, AFFICHES_EN_ACCUEIL)
			.map(affiche),
		derniereLecture: journal
			.filter((entree) => entree.atteinte)
			.slice(0, AFFICHES_EN_ACCUEIL)
			.map(affiche),
		ordres: ordres.slice(0, ORDRES_EN_ACCUEIL).map((ordre) => ({
			id: ordre.id,
			titre: ordre.titre,
			auteur: ordre.auteur.parti ? 'un membre parti' : ordre.auteur.nom,
			nombreDEntrees: ordre.nombreDEntrees,
			suivi: ordre.suivi,
			pourcentage: pourcentageAffiche(ordre.progression)
		}))
	};
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
