package dev.probe

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

@Entity(tableName = "notes")
data class Note(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val text: String,
    val createdAt: Long,
)

@Dao
interface NoteDao {
    @Insert
    fun insert(note: Note): Long

    @Query("SELECT COUNT(*) FROM notes")
    fun count(): Int
}

@Database(entities = [Note::class], version = 1, exportSchema = false)
abstract class ProbeDatabase : RoomDatabase() {
    abstract fun notes(): NoteDao

    companion object {
        @Volatile private var instance: ProbeDatabase? = null

        // One connection pool for the life of the process and no explicit close, so a small
        // write stays in probe.db-wal: SQLite only checkpoints after 1000 pages or on close.
        fun get(context: Context): ProbeDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, ProbeDatabase::class.java, "probe.db")
                    .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                    .allowMainThreadQueries()
                    .build()
                    .also { instance = it }
            }
    }
}
