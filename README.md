# readerbox

Un compagnon partagé de l'univers Marvel, pour un groupe fermé d'une vingtaine d'amis.

Consigner ce qu'on lit et regarde — comics, films, séries, romans — noter, écrire des avis, et voir où en sont les autres sans se faire gâcher ce qu'on n'a pas encore lu. Créer et suivre des ordres de lecture, parce que la vraie question dans cet univers n'est pas « quoi lire » mais « dans quel ordre ». Et voir apparaître, au fil des lectures, un graphe des liens entre personnages, séries et events — qui ne montre que ce qu'on a effectivement atteint.

Projet personnel. Pas de monétisation, pas d'ouverture au public : le groupe fermé est la forme du produit, pas une étape avant autre chose.

## Deux mots à ne jamais confondre

- **Consigner** — poser une œuvre sur une étagère, quelle qu'elle soit. Mettre un comic en « à découvrir » est une consignation.
- **Atteindre** — avoir terminé ou abandonné une œuvre.

C'est **atteindre** qui donne le droit de voir, fait avancer un ordre et alimente le graphe. Presque toutes les règles du produit en dépendent.

## Stack

Tout est gratuit et le reste — c'est une contrainte du projet, pas un accident.

- SvelteKit avec l'adaptateur Cloudflare, rendu côté serveur
- Cloudflare Workers et D1, Drizzle pour le schéma et les migrations
- Tailwind, Vitest
- Cytoscape.js (MIT) pour le rendu du graphe, chargé à la demande dans le navigateur
- Node 22 (voir `.nvmrc`)

Le rendu côté serveur n'est pas un détail : le masquage anti-spoiler filtre les textes **avant** sérialisation. Un masquage appliqué côté client enverrait le texte dans la charge utile, ce qui n'est pas du masquage.

## Démarrer

```sh
nvm use
npm install
npm run dev
```

Les clés d'API des sources de données sont des secrets Cloudflare Worker, jamais versionnées. En local elles vont dans `.dev.vars`, ignoré par git.

## Commandes

| Commande              | Effet                                  |
| --------------------- | -------------------------------------- |
| `npm run dev`         | Serveur de développement               |
| `npm test`            | Tests unitaires                        |
| `npm run check`       | Vérification des types                 |
| `npm run lint`        | Prettier et ESLint                     |
| `npm run db:generate` | Générer une migration depuis le schéma |
| `npm run db:migrate`  | Appliquer les migrations               |
| `npm run cron:dev`    | Worker planifié en local               |
| `npm run cron:deploy` | Déployer le Worker planifié            |

Le Worker planifié est un **second** Worker (`workers/cron.ts`, `wrangler.cron.jsonc`), sur la même base D1. Ce n'est pas un choix d'architecture : l'adaptateur SvelteKit efface et réécrit le fichier désigné par `main` dans `wrangler.jsonc`, et son `_worker.js` n'exporte que `fetch`. Le Cron Trigger — seul ordonnanceur du palier gratuit — y reprend les cascades de recueil interrompues et y matérialise le graphe de chaque membre, deux traitements qui ne tiennent pas dans les 10 ms de temps processeur d'une requête.

## Conception

Le projet est documenté avant d'être codé. Dans l'ordre de lecture :

- `docs/ideation/` — l'idéation d'origine, 42 candidats bruts et les 7 retenus. Le projet est parti d'un « Letterboxd pour les livres » avant de pivoter vers Marvel ; la trace est conservée.
- `docs/brainstorms/` — les exigences : 53 exigences, 7 parcours, 15 exemples d'acceptation.
- `docs/plans/` — le plan d'implémentation en 10 unités et 4 phases, avec ses décisions techniques et ses questions encore ouvertes.
- `docs/decisions/` — les décisions prises en cours de route, à commencer par le choix des sources de données.
