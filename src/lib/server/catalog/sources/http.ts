import type { MotifEchec, Resultat } from './types';

/**
 * Le transport des adaptateurs de source, et la cadence qui le borne.
 *
 * Deux raisons pour que ce fichier existe séparément des adaptateurs :
 *
 * 1. **Les tests ne doivent jamais appeler les vraies API.** Le transport est un
 *    paramètre, pas un import : un adaptateur reçoit sa fonction d'appel et les
 *    tests lui en donnent une qui rend des fixtures. Il n'y a donc rien à
 *    intercepter globalement, et rien qui puisse fuir vers le réseau par oubli.
 * 2. **La cadence de Metron est la contrainte la plus dure de l'unité.** Elle est
 *    mesurée — étranglement vers la dizaine d'appels consécutifs, douze secondes
 *    de récupération annoncées dans le corps du 429, 2,5 s entre appels qui passe
 *    — et elle mérite un mécanisme nommé plutôt qu'un `await` dispersé dans
 *    l'adaptateur.
 */

/** Un appel HTTP. `fetch` en production, une fonction de test ailleurs. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

/** L'horloge et l'attente, injectables pour que les tests n'attendent pas vraiment. */
export interface Chronometre {
	maintenant: () => number;
	dormir: (ms: number) => Promise<void>;
}

export const CHRONOMETRE_REEL: Chronometre = {
	maintenant: () => Date.now(),
	dormir: (ms) => new Promise((resoudre) => setTimeout(resoudre, ms))
};

/**
 * Une file qui espace le **début** des appels d'au moins `intervalleMs`.
 *
 * L'espacement porte sur le départ et non sur la fin, parce que c'est le débit
 * d'entrée que la source compte : deux appels lancés à 2,5 s d'écart lui
 * parviennent à 2,5 s d'écart, quelle que soit la durée du premier.
 *
 * **La portée est l'isolat, et il faut le savoir.** Sur Cloudflare Workers,
 * plusieurs isolats peuvent servir le groupe en parallèle et chacun aura sa
 * propre file : la cadence est un plafond de bonne volonté, pas une garantie
 * distribuée. Ce qui protège réellement le quota à vingt membres est le cache
 * court des réponses de recherche — cette file, elle, empêche qu'un seul
 * parcours enchaîne dix appels en une seconde et se fasse étrangler tout seul.
 */
export function creerCadence(
	intervalleMs: number,
	chronometre: Chronometre = CHRONOMETRE_REEL
): <T>(travail: () => Promise<T>) => Promise<T> {
	let dernierDepart = Number.NEGATIVE_INFINITY;
	let file: Promise<void> = Promise.resolve();

	return function passer<T>(travail: () => Promise<T>): Promise<T> {
		const tour = file.then(async () => {
			const attente = dernierDepart + intervalleMs - chronometre.maintenant();
			if (attente > 0) await chronometre.dormir(attente);
			dernierDepart = chronometre.maintenant();
		});
		// La file ne retient que l'attente, jamais le travail : un appel lent ne
		// doit pas décaler ceux qui suivent au-delà de l'intervalle.
		file = tour.catch(() => undefined);
		return tour.then(travail);
	};
}

/**
 * Le motif d'échec d'un code de statut.
 *
 * Le 429 est le cas qui compte : c'est un **quota**, donc une réponse
 * réessayable plus tard, et surtout pas une panne. Les confondre ferait passer
 * une soirée d'exploration à vingt pour une source morte.
 */
export function motifDeStatut(statut: number): MotifEchec {
	if (statut === 429) return 'quota';
	if (statut === 401 || statut === 403) return 'non-autorise';
	if (statut === 408 || statut === 425 || statut >= 500) return 'indisponible';
	return 'illisible';
}

/**
 * Le délai de récupération annoncé par la source, en millisecondes.
 *
 * Metron l'écrit en clair dans le corps de sa réponse 429 (« Expected available
 * in 12 seconds ») plutôt que dans un en-tête ; l'en-tête standard est lu
 * d'abord au cas où il apparaîtrait. Une valeur absente vaut le repli, jamais
 * zéro : traiter un quota comme immédiatement levé rendrait l'étranglement
 * permanent.
 */
export function delaiDeRecuperation(reponse: Response, corps: string, repliMs: number): number {
	const entete = Number(reponse.headers.get('retry-after') ?? '');
	if (Number.isFinite(entete) && entete > 0) return entete * 1000;

	const annonce = /(\d+)\s*second/i.exec(corps);
	if (annonce) return Number(annonce[1]) * 1000;

	return repliMs;
}

/**
 * Le résultat d'un appel JSON. `null` signifie **404** : la source répond
 * qu'elle ne connaît pas cette ressource, ce qui n'est pas un échec.
 *
 * Les listes de recherche ne rendent jamais 404 — elles rendent un décompte nul
 * — donc l'ambiguïté n'existe pas en pratique.
 */
export type ReponseJson = Resultat<unknown | null>;

export interface OptionsAppel {
	transport: Transport;
	entetes?: Record<string, string>;
	signal?: AbortSignal;
	/** Appelé sur un 429, avec le délai annoncé : c'est ce qui arme la mise en veille. */
	surQuota?: (delaiMs: number) => void;
}

/**
 * Un appel qui ne lève jamais pour un échec attendu.
 *
 * C'est le premier des deux partis pris de `types.ts` pris à la lettre : quota,
 * indisponibilité, non-autorisé et illisible sont des valeurs de retour. Une
 * exception traverserait la page de recherche et ferait échouer tout l'écran là
 * où une source manquante ne doit dégrader qu'une colonne.
 */
export async function lireJson(url: string, options: OptionsAppel): Promise<ReponseJson> {
	let reponse: Response;
	try {
		reponse = await options.transport(url, {
			headers: { Accept: 'application/json', ...options.entetes },
			signal: options.signal
		});
	} catch {
		// Coupure réseau, DNS, abandon : la source est injoignable, donc réessayable.
		return { ok: false, motif: 'indisponible' };
	}

	if (reponse.status === 404) return { ok: true, valeur: null };

	if (!reponse.ok) {
		const motif = motifDeStatut(reponse.status);
		if (motif === 'quota' && options.surQuota) {
			const corps = await reponse.text().catch(() => '');
			options.surQuota(delaiDeRecuperation(reponse, corps, 15_000));
		}
		return { ok: false, motif };
	}

	try {
		return { ok: true, valeur: await reponse.json() };
	} catch {
		// Un corps qui n'est pas du JSON là où le contrat en promet : la source a
		// répondu quelque chose qu'on ne sait pas lire, ce n'est pas une panne.
		return { ok: false, motif: 'illisible' };
	}
}

/**
 * La mise en veille d'une source qui vient d'annoncer un quota.
 *
 * Sans elle, vingt membres derrière une clé unique rejouent chacun l'appel qui
 * vient d'être refusé et prolongent l'étranglement au lieu de le laisser passer.
 * Avec elle, la source répond `quota` sans toucher au réseau jusqu'à l'échéance
 * qu'elle a elle-même annoncée.
 */
export function creerVeille(chronometre: Chronometre = CHRONOMETRE_REEL) {
	let jusqua = 0;

	return {
		enVeille: () => chronometre.maintenant() < jusqua,
		armer: (delaiMs: number) => {
			jusqua = Math.max(jusqua, chronometre.maintenant() + delaiMs);
		}
	};
}

/** Une chaîne de requête, sans les paramètres nuls. */
export function parametres(valeurs: Record<string, string | number | undefined>): string {
	const query = new URLSearchParams();
	for (const [nom, valeur] of Object.entries(valeurs)) {
		if (valeur !== undefined && valeur !== '') query.set(nom, String(valeur));
	}
	return query.toString();
}

/**
 * Valide un jeton de page avant de le rappeler.
 *
 * `Page.suite` est « opaque à repasser tel quel », et les sources y mettent une
 * URL entière. La repasser sans vérifier son origine ferait de la pagination une
 * requête sortante arbitraire pilotée par le contenu d'une réponse — ou, si le
 * jeton transite par une URL de page, par un membre. Le préfixe est donc
 * revérifié à chaque usage.
 */
export function suiteAcceptable(suite: string | undefined, base: string): string | null {
	if (!suite) return null;
	return suite.startsWith(base) ? suite : null;
}
