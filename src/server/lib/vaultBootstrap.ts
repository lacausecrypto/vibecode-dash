import { stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type BootstrapFile = {
  path: string;
  content: string;
};

export type BootstrapResult = {
  created: string[];
  skipped: string[];
  vaultRoot: string;
  files: number;
};

/**
 * Karpathy-style LLM OS memory layout for a personal vault.
 *
 * Principles:
 * - Working memory = current session context (not stored here)
 * - Long-term memory = evergreen notes in well-named folders
 * - Episodic memory = dated journal + session archives
 * - Retrieval = FTS5 + wikilinks + manual MOCs
 * - Write path = assistant captures facts via <memory> blocks → persisted in SQLite;
 *   human captures in /Inbox; both migrate to evergreen notes over time.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getBootstrapFiles(vaultRoot: string): BootstrapFile[] {
  const _root = vaultRoot; // present for future path customisation
  void _root;
  const date = today();

  return [
    {
      path: '00_MOC.md',
      content: `---
type: map
title: Map of Content
collab_reviewed: true
---

# Map of Content · mybrain

Point d'entrée navigable. Chaque dossier a un rôle précis inspiré du modèle LLM OS d'Andrej Karpathy : mémoire persistante, distillée et organisée.

## Couches de mémoire

- **[[Persona/identity]]** · qui tu es, comment tu travailles · *chargé dans chaque turn d'agent*
- **[[Persona/values]]** · principes de décision · *chargé dans chaque turn d'agent*
- **[[Projects/_template]]** · un projet = un fichier, revu hebdomadairement
- **[[People/_template]]** · une personne = un fichier, mise à jour après chaque interaction
- **[[Concepts/_template]]** · idées réutilisables (Zettelkasten-style evergreens)
- **[[Inbox/_README]]** · capture rapide, à trier dans les 48 h
- **[[Daily/${date}]]** · journal quotidien, source d'épisodes
- **[[Sessions/_README]]** · archives de conversations agent marquantes

## Workflow

1. **Capture** → Inbox ou directement dans Daily. Le dashboard Agent peut aussi persister via blocs \`<memory>\`.
2. **Distill** → transforme une note Inbox en evergreen Concept / Project / Person après 24-48 h.
3. **Connect** → ajoute des wikilinks \`[[note]]\`. Le graphe devient utile quand il y a du maillage.
4. **Retrieve** → FTS5 automatique côté agent + recherche Obsidian + Maps of Content.

## Ligne éditoriale

- Une idée = une note. Une note = un titre précis.
- Préfère l'écrit dense : si tu peux le dire en 4 phrases, ne fais pas 40.
- Les dates se mettent en front-matter (\`date:\`), pas dans le corps.
- Un \`collab_reviewed: true\` indique qu'une note est stable et peut être citée.
- Les "insights" vont dans Concepts ; les "faits opérationnels" dans Projects/People.
`,
    },
    {
      path: 'Persona/identity.md',
      content: `---
type: persona
subtype: identity
collab_reviewed: false
updated: ${date}
---

# Identity

> Ce fichier est chargé en haut du contexte de **chaque** turn d'agent. Le modèle le traite comme source d'autorité sur qui tu es. Édite-le à la main ou demande à l'agent de le mettre à jour.

## Rôle

- \`[à compléter]\` — ton titre / métier
- \`[à compléter]\` — domaines d'expertise principaux
- \`[à compléter]\` — stack technique privilégiée

## Contexte actuel

- Projets actifs : voir [[Projects/_template]]
- Problèmes/chantiers en cours : \`[à compléter]\`

## Mode de collaboration préféré

- Communication : \`[direct·concis·sans fluff]\`
- Niveau technique attendu : \`[sénior·junior·mixte]\`
- Ce qui te frustre : \`[à compléter — sur-abstraction ? réponses vagues ? suggestions génériques ?]\`
- Ce qui te fait progresser : \`[à compléter — challenge·critique constructive·alternatives·exemples concrets ?]\`

## Signaux à l'agent

- Quand je dis X, ça veut dire Y : \`[à compléter]\`
- Quand je demande un "plan", je veux \`[structure·ordre·critères de succès]\`
- Quand je demande une "critique", je veux \`[failles + next best action, pas un bilan équilibré]\`
`,
    },
    {
      path: 'Persona/values.md',
      content: `---
type: persona
subtype: values
collab_reviewed: false
updated: ${date}
---

# Values & decision style

> Ce fichier est chargé dans chaque turn. Il doit pouvoir guider un arbitrage quand tu ne l'as pas précisé.

## Principes

- **\`[à compléter — ex: simplicité d'exécution > élégance théorique]\`**
- **\`[à compléter — ex: rigueur des tests > vitesse d'itération]\`**
- **\`[à compléter — ex: local-first > cloud-first]\`**
- **\`[à compléter — ex: ergonomie utilisateur > pureté du code]\`**

## Biais assumés

- \`[à compléter — ex: je sur-investis dans le scaffolding initial]\`
- \`[à compléter — ex: j'ai tendance à préférer les CLI aux GUI]\`

## Trade-offs usuels

| Axe | Je préfère | Sauf si |
|-----|-----------|---------|
| Temps vs qualité | \`[à compléter]\` | \`[à compléter]\` |
| Build vs buy | \`[à compléter]\` | \`[à compléter]\` |
| Premature abstraction vs duplication | \`[duplication tant qu'il n'y a pas 3+ cas]\` | \`[à compléter]\` |

## Anti-patterns à éviter

- \`[à compléter]\`
- \`[à compléter]\`
`,
    },
    {
      path: 'Projects/_template.md',
      content: `---
type: project
status: active
priority: p1
started: ${date}
updated: ${date}
---

# [Nom du projet]

## Problème résolu

\`[Une phrase : qui, quoi, pourquoi c'est utile.]\`

## État actuel

- **Phase** : idéation · prototype · v1 · maintenance · archivé
- **Stack** : \`[langages, frameworks, services]\`
- **Repo / cwd** : \`[chemin local ou url]\`
- **Déploiement** : \`[où tourne quoi]\`

## Décisions clés

> Traces des choix irréversibles ou coûteux à changer. Inclure le **pourquoi**.

- \`[date]\` — \`[décision]\` · *raison : [...]*

## Next best action

> Mise à jour chaque revue hebdo. Une seule action, observable.

- \`[à compléter — sous 48 h]\`

## Risques & blocages

- \`[à compléter]\`

## Notes liées

- \`[[Concepts/...]]\`
- \`[[People/...]]\`
`,
    },
    {
      path: 'People/_template.md',
      content: `---
type: person
relation: \`[collègue|client|mentor|ami|...]\`
updated: ${date}
---

# [Prénom Nom]

## Qui

- **Rôle** : \`[titre, entreprise, contexte de rencontre]\`
- **Expertise** : \`[domaines]\`
- **Communication** : \`[canal préféré, horaires, style]\`

## Ce qui compte pour iel

- \`[objectifs professionnels, motivations profondes]\`
- \`[sujets sensibles à éviter]\`

## Historique des interactions

> Dernières conversations importantes, promesses faites, sujets en suspens.

- \`[date]\` · \`[sujet]\` · \`[action qui m'incombe ou qui l'incombe]\`

## Notes liées

- \`[[Projects/...]]\`
`,
    },
    {
      path: 'Concepts/_template.md',
      content: `---
type: concept
status: evergreen
updated: ${date}
---

# [Titre du concept]

> Une idée réutilisable, formulée en tant qu'affirmation (pas question). Si tu ne peux pas la défendre en 5 lignes, ce n'est pas mûr — mets-la dans Inbox.

## Définition

\`[Le concept en 2-3 phrases maximum.]\`

## Pourquoi c'est utile

\`[Quand tu mobilises ce concept, il te fait gagner quoi ?]\`

## Exemple concret

\`[Un cas réel, de préférence tiré d'un projet à toi : [[Projects/...]]]\`

## Limites

\`[Quand ce concept cesse d'être utile ou devient dangereux.]\`

## Références

- Source originale : \`[url, livre, discussion]\`

## Maillage

- S'appuie sur : \`[[Concepts/...]]\`
- S'oppose à : \`[[Concepts/...]]\`
- Appliqué dans : \`[[Projects/...]]\`
`,
    },
    {
      path: 'Inbox/_README.md',
      content: `---
type: readme
collab_reviewed: true
---

# Inbox

> Capture rapide. Traite en < 48 h. Si une note reste > 7 jours ici, elle meurt ou remonte en Concept/Project/People.

## Règle du 2 minutes

Si tu peux traiter une note en 2 min, fais-le maintenant : déplace, reformule, lie.

## Flux recommandé

1. Capture brute ici (titre uniquement ok, pas de front-matter requis).
2. À chaque revue (quotidien ou bi-quotidien) :
   - **Distiller** → reformule en evergreen dans \`Concepts/\`
   - **Opérationnaliser** → ajoute à la section "Next best action" d'un \`Projects/\`
   - **Archiver** → glisse dans \`Daily/\` du jour de capture
   - **Supprimer** → si ce n'est plus pertinent
3. Quand tu ressors une idée, enrichis-la (n'écris pas deux fois).

## Astuce agent

Le dashboard peut pousser ici via \`POST /api/obsidian/capture\` avec \`{ content, path: "Inbox/<slug>.md" }\` ou \`{ content, daily: true }\` pour coller au Daily du jour.
`,
    },
    {
      path: `Daily/${date}.md`,
      content: `---
type: daily
date: ${date}
---

# ${date}

## Focus du jour

- \`[1-3 objectifs prioritaires, phrasés en résultat observable]\`

## Log

> Ajoute ici les événements marquants, décisions, apprentissages. Chaque ligne timestampée (\`HH:MM\`).

- \`${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\` · Bootstrap du vault mybrain via vibecode-dash.

## Revue

- **Ce qui a avancé** : \`[à compléter]\`
- **Ce qui bloque** : \`[à compléter]\`
- **Une chose que j'ai apprise** : \`[à compléter — remonter dans Concepts si non trivial]\`

## Next

- Demain : \`[3 actions max]\`
`,
    },
    {
      path: 'Sessions/_README.md',
      content: `---
type: readme
---

# Sessions archivées

> Archive markdown des conversations agent marquantes. Le SQLite garde l'historique complet ; ce dossier sert à conserver les pépites en markdown navigable dans Obsidian.

## Quand archiver ici

- Une session a produit une décision importante → sauve-la avec le nom \`YYYY-MM-DD_slug.md\`.
- Une session est une source de distillation riche → extrait les evergreens dans \`Concepts/\` et référence la session ici comme provenance.

## Format recommandé

\`\`\`yaml
---
type: session
provider: claude|codex
model: claude-sonnet-4-6
date: 2026-04-19
project: [[Projects/nom]]
---
\`\`\`

Puis copie la conversation nettoyée (enlève les blocs \`<memory>\` déjà persistés, les meta tokens/coûts sont dans la DB).
`,
    },
    {
      path: '.obsidian/templates/daily.md',
      content: `---
type: daily
date: {{date:YYYY-MM-DD}}
---

# {{date:YYYY-MM-DD}}

## Focus du jour

-

## Log

-

## Revue

- **Ce qui a avancé** :
- **Ce qui bloque** :
- **Une chose que j'ai apprise** :

## Next

-
`,
    },
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrapVault(vaultRoot: string): Promise<BootstrapResult> {
  const absRoot = resolve(vaultRoot);
  const files = getBootstrapFiles(absRoot);

  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const abs = resolve(join(absRoot, file.path));
    if (!abs.startsWith(`${absRoot}/`) && abs !== absRoot) {
      continue;
    }

    await mkdir(dirname(abs), { recursive: true });

    if (await fileExists(abs)) {
      skipped.push(file.path);
      continue;
    }

    await writeFile(abs, file.content, 'utf8');
    created.push(file.path);
  }

  return {
    vaultRoot: absRoot,
    created,
    skipped,
    files: files.length,
  };
}
