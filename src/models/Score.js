import mongoose from 'mongoose'

const scoreSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    username: {
      type: String,
      required: true,
    },

    bestScore: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
)

export const Score = mongoose.model('Score', scoreSchema)