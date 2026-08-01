import type { Chronometre, Transport } from './http';

/**
 * Le harnais des adaptateurs de source.
 *
 * **Aucun test n'appelle les vraies API**, et c'est structurel plutôt que
 * discipliné : le transport est un paramètre des adaptateurs, et les tests lui
 * en passent un qui rend des fixtures capturées sur les vraies réponses. Il n'y
 * a rien à intercepter globalement, donc rien qui puisse fuir vers le réseau par
 * oubli — ni faire dépendre la suite de tests d'un quota amont.
 */

export interface ReponseFactice {
	/** Le fragment d'URL qui déclenche cette réponse. La première correspondance gagne. */
	quand: string;
	statut?: number;
	corps?: unknown;
	/** Un corps brut, pour les réponses qui ne sont pas du JSON. */
	texte?: string;
	entetes?: Record<string, string>;
	/** Simule une coupure réseau : le transport lève, comme `fetch` le ferait. */
	coupure?: boolean;
}

export interface TransportFactice {
	transport: Transport;
	/** Les URL appelées, dans l'ordre. C'est ce qui prouve qu'un cache a évité un appel. */
	appels: string[];
	/** L'instant de chaque appel selon le chronomètre fourni — pour vérifier la cadence. */
	instants: number[];
}

export function transportFactice(
	reponses: ReponseFactice[],
	chronometre?: Chronometre
): TransportFactice {
	const appels: string[] = [];
	const instants: number[] = [];

	const transport: Transport = async (url) => {
		appels.push(url);
		instants.push(chronometre ? chronometre.maintenant() : 0);

		const trouvee = reponses.find((reponse) => url.includes(reponse.quand));
		// Une URL qu'aucune réponse ne couvre est une erreur de test, pas un cas du
		// produit : le statut choisi est celui qu'aucun code de production n'attend,
		// pour que l'oubli se voie au lieu de se déguiser en dégradation plausible.
		if (!trouvee) return new Response('aucune réponse factice', { status: 418 });

		if (trouvee.coupure) throw new TypeError('réseau coupé');

		const corps =
			trouvee.texte ?? (trouvee.corps === undefined ? '' : JSON.stringify(trouvee.corps));
		return new Response(corps, {
			status: trouvee.statut ?? 200,
			headers: trouvee.entetes ?? {}
		});
	};

	return { transport, appels, instants };
}

/**
 * Un chronomètre dont l'attente est instantanée.
 *
 * La cadence de Metron est de 2,5 s entre appels : une suite de tests qui
 * l'attendrait vraiment durerait des minutes et personne ne la lancerait. Le
 * temps avance donc à chaque `dormir`, ce qui rend la cadence **vérifiable**
 * plutôt que seulement supportable.
 */
export function chronometreFactice(depart = 1_000_000): Chronometre & {
	avancer: (ms: number) => void;
} {
	let instant = depart;
	return {
		maintenant: () => instant,
		dormir: async (ms: number) => {
			instant += ms;
		},
		avancer: (ms: number) => {
			instant += ms;
		}
	};
}
