import type { AdaptateurDeSource, AxeDeParcours } from './types';
import { creerMetron } from './metron';
import { creerTmdb } from './tmdb';

/**
 * Les adaptateurs disponibles, montés depuis les secrets du Worker.
 *
 * **Une source sans identifiants est absente, pas en panne.** Elle ne figure
 * simplement pas dans la liste : la recherche marche avec celles qui restent, et
 * personne ne voit passer une dégradation pour une source qu'on n'a jamais
 * configurée. C'est la même règle que dans les sondes de U1.
 *
 * Comic Vine n'a pas d'adaptateur : la décision 001 l'écarte, et lui en écrire un
 * « au cas où » entretiendrait l'illusion d'une source qu'on peut rallumer.
 *
 * **La mémoïsation est délibérée.** Un adaptateur Metron porte sa cadence et sa
 * veille de quota dans sa fermeture : en reconstruire un à chaque requête
 * rendrait les deux inopérantes, chaque page repartant d'une file vide et d'une
 * veille désarmée. La clé est l'empreinte des identifiants, pour qu'une rotation
 * de secret reconstruise bien l'adaptateur.
 */

export interface SecretsDeSource {
	METRON_USER?: string;
	METRON_PASS?: string;
	TMDB_KEY?: string;
}

const montes = new Map<string, AdaptateurDeSource[]>();

export function adaptateursDe(secrets: SecretsDeSource): AdaptateurDeSource[] {
	const cle = [secrets.METRON_USER, secrets.METRON_PASS, secrets.TMDB_KEY]
		.map((valeur) => (valeur ? String(valeur.length) : '-'))
		.join('/');

	const deja = montes.get(cle);
	if (deja) return deja;

	const adaptateurs: AdaptateurDeSource[] = [];

	if (secrets.METRON_USER && secrets.METRON_PASS) {
		adaptateurs.push(
			creerMetron({ utilisateur: secrets.METRON_USER, motDePasse: secrets.METRON_PASS })
		);
	}
	if (secrets.TMDB_KEY) {
		adaptateurs.push(creerTmdb({ jeton: secrets.TMDB_KEY }));
	}

	montes.set(cle, adaptateurs);
	return adaptateurs;
}

/**
 * Les adaptateurs qui savent parcourir cet axe.
 *
 * Filtrer sur les capacités plutôt que d'appeler tout le monde évite deux
 * choses : une requête payée à une source qui répondra toujours vide, et — plus
 * grave — une page vide présentée comme une dégradation, qui ferait croire à une
 * panne là où il n'y a qu'une source qui ne couvre pas cet axe.
 */
export function adaptateursPourLAxe(
	adaptateurs: AdaptateurDeSource[],
	axe: AxeDeParcours
): AdaptateurDeSource[] {
	const capacite = {
		personnage: 'parcoursParPersonnage',
		serie: 'parcoursParSerie',
		createur: 'parcoursParCreateur',
		event: 'parcoursParEvent'
	} as const;

	return adaptateurs.filter((adaptateur) => adaptateur.capacites[capacite[axe]]);
}
