import { Types, Document } from 'mongoose';

/** Safely get string ID from a Mongoose document */
export function docId(doc: Document | { _id: Types.ObjectId | string }): string {
  return doc._id?.toString() ?? '';
}
