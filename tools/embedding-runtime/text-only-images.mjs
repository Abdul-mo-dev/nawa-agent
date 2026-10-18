/** The upstream image backend is unreachable in the pinned text model. Keeping
 * an explicit throwing boundary avoids distributing unrelated native codecs. */
export default function imageTasksUnavailable() {
  throw new Error('Image tasks are not part of the Nawa text embedding runtime.')
}
